package worker

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"unicode"
	"unicode/utf16"

	"github.com/kevynsax/book-reader/backend/internal/config"
	"github.com/kevynsax/book-reader/backend/internal/data/biblebooks"
	"github.com/kevynsax/book-reader/backend/internal/lib/pool"
	"github.com/kevynsax/book-reader/backend/internal/lib/sanitize"
	"github.com/kevynsax/book-reader/backend/internal/lib/sentences"
	"github.com/kevynsax/book-reader/backend/internal/model"
	"github.com/kevynsax/book-reader/backend/internal/queue"
	"github.com/kevynsax/book-reader/backend/internal/svc/normalizer"
	"github.com/kevynsax/book-reader/backend/internal/svc/ocr"
	"github.com/kevynsax/book-reader/backend/internal/svc/pdf"
)

// utf16Slice slices s by UTF-16 code-unit offsets — JS string indexes, which
// is what startChar has always stored (and what the frontend produces).
// end < 0 means "to the end".
func utf16Slice(s string, start, end int) string {
	units := utf16.Encode([]rune(s))
	if start < 0 {
		start = 0
	}
	if start > len(units) {
		start = len(units)
	}
	if end < 0 || end > len(units) {
		end = len(units)
	}
	if start >= end {
		return ""
	}
	return string(utf16.Decode(units[start:end]))
}

// extractChapterPageTexts returns the chapter's text sliced per page (by
// startChar/endChar), kept as separate strings so phase 2 can apply the
// cross-page sentence-continuation rule.
func extractChapterPageTexts(chapters []model.Chapter, idx int, ocrPages []model.OcrPage, lastPage int) []string {
	chapter := chapters[idx]
	startPage := chapter.StartPage
	startChar := chapter.StartChar
	endPage := lastPage
	endChar := -1
	if idx+1 < len(chapters) {
		endPage = chapters[idx+1].StartPage
		endChar = chapters[idx+1].StartChar
	}

	var pages []model.OcrPage
	for _, p := range ocrPages {
		if p.Page >= startPage && p.Page <= endPage && p.Status == model.OcrComplete {
			pages = append(pages, p)
		}
	}
	sort.SliceStable(pages, func(i, j int) bool { return pages[i].Page < pages[j].Page })

	out := make([]string, len(pages))
	for i, p := range pages {
		text := sanitize.PageText(p.Text)
		isFirst := p.Page == startPage
		isLast := p.Page == endPage
		switch {
		case isFirst && isLast:
			out[i] = utf16Slice(text, startChar, endChar)
		case isFirst:
			out[i] = utf16Slice(text, startChar, -1)
		case isLast:
			if endChar >= 0 {
				out[i] = utf16Slice(text, 0, endChar)
			} else {
				out[i] = text
			}
		default:
			out[i] = text
		}
	}
	return out
}

// speechLanguage is a page's own language for speech normalization, falling
// back to the default when OCR couldn't determine it.
func speechLanguage(language string) string {
	if language != "" && language != "unknown" {
		return biblebooks.ResolveLang(language)
	}
	return biblebooks.ResolveLang(config.DefaultLanguage)
}

// bookSpeechLanguage is the book's resolved speech language: the
// once-detected book language when set, otherwise the per-page fallback.
func BookSpeechLanguage(book *model.Book, fallback string) string {
	if book.Language != nil && *book.Language != "" && *book.Language != "unknown" {
		return biblebooks.ResolveLang(*book.Language)
	}
	return speechLanguage(fallback)
}

func startsLowercase(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) {
			return r != unicode.ToUpper(r) && r == unicode.ToLower(r)
		}
	}
	return false
}

// assembleSentences: each line of the (phase-1 reflowed) page text is a
// sentence. At a page seam, a first line that starts lowercase continues the
// previous page's last sentence; a capital begins a new sentence.
func assembleSentences(pageTexts []string) []string {
	var out []string
	for pi, pageText := range pageTexts {
		li := 0
		for _, line := range strings.Split(pageText, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			if pi > 0 && li == 0 && len(out) > 0 && startsLowercase(line) {
				out[len(out)-1] += " " + line
			} else {
				out = append(out, line)
			}
			li++
		}
	}
	return out
}

// chapterLanguage: first non-'unknown' page language in the chapter's page
// range, resolved to a supported ISO code.
func chapterLanguage(chapters []model.Chapter, idx int, ocrPages []model.OcrPage, lastPage int) string {
	startPage := chapters[idx].StartPage
	endPage := lastPage
	if idx+1 < len(chapters) {
		endPage = chapters[idx+1].StartPage
	}
	for _, p := range ocrPages {
		if p.Page >= startPage && p.Page <= endPage && p.Status == model.OcrComplete &&
			p.Language != "" && p.Language != "unknown" {
			return biblebooks.ResolveLang(p.Language)
		}
	}
	return biblebooks.ResolveLang(config.DefaultLanguage)
}

// chapterSpeechLanguage: the once-detected book language when set, otherwise
// the per-chapter OCR detection.
func chapterSpeechLanguage(book *model.Book, idx int) string {
	if book.Language != nil && *book.Language != "" && *book.Language != "unknown" {
		return biblebooks.ResolveLang(*book.Language)
	}
	return chapterLanguage(book.Chapters, idx, book.OcrPages, book.LastPage)
}

// readPage loads a rasterized page image for shipping inside a task message
// (workers may run on other machines, so payloads travel by value).
func readPage(folderPath string, pageNum int) []byte {
	imagePath := pdf.FindPageImagePath(folderPath, pageNum)
	if imagePath == "" {
		return nil
	}
	data, err := os.ReadFile(imagePath)
	if err != nil {
		return nil
	}
	return data
}

// ensureBookLanguage backfills the book-wide language for older books that
// predate summary-page detection. No-op when already set or unavailable.
func (w *Worker) ensureBookLanguage(ctx context.Context, r *run) {
	book := r.book
	if book.Language != nil && *book.Language != "" && *book.Language != "unknown" {
		return
	}
	if len(book.SummaryPages) == 0 {
		return
	}
	image := readPage(book.FolderPath, book.SummaryPages[0])
	if image == nil {
		return
	}
	language, err := w.Q.DetectLanguage(ctx, image)
	if err != nil || language == "" || language == "unknown" {
		return
	}
	_ = r.withSave(ctx, func() { book.Language = &language })
	w.emit(book, map[string]any{"language": language})
}

func (w *Worker) setProgress(ctx context.Context, r *run, current, total int, message string, status model.BookStatus) error {
	book := r.book
	err := r.withSave(ctx, func() {
		book.Progress = model.Progress{Current: current, Total: total, Message: message}
		if status != "" {
			book.Status = status
		}
	})
	if err != nil {
		return err
	}
	w.emit(book, map[string]any{"status": book.Status, "progress": book.Progress})
	return nil
}

// ProcessBook runs the import pipeline: split PDF → cover → title → language
// → OCR pool → chapter detection → awaiting review.
func (w *Worker) ProcessBook(ctx context.Context, bookID string, resume bool) error {
	release, ok := w.TryRun(bookID)
	if !ok {
		log.Printf("processBook %s: a run is already in flight; ignoring", bookID)
		return nil
	}
	defer release()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	r := &run{w: w, book: book}

	if err := w.processBookInner(ctx, r, resume); err != nil {
		message := err.Error()
		saveErr := r.withSave(ctx, func() {
			book.Status = model.StatusError
			book.ErrorMessage = &message
		})
		w.emit(book, map[string]any{"status": model.StatusError, "errorMessage": message})
		if saveErr != nil {
			return saveErr
		}
	}
	return nil
}

func (w *Worker) processBookInner(ctx context.Context, r *run, resume bool) error {
	book := r.book

	if err := w.setProgress(ctx, r, 0, 1, "Splitting pages…", model.StatusSplittingPages); err != nil {
		return err
	}
	totalPages, err := pdf.SplitIntoPages(book.FilePath, book.FolderPath)
	if err != nil {
		return err
	}
	if err := r.withSave(ctx, func() { book.TotalPages = totalPages }); err != nil {
		return err
	}

	if err := w.setProgress(ctx, r, 0, 1, "Extracting cover…", model.StatusExtractingCover); err != nil {
		return err
	}
	if coverSrcPath := pdf.FindPageImagePath(book.FolderPath, book.CoverPage); coverSrcPath != "" {
		coverDest := filepath.Join(book.FolderPath, "cover.jpg")
		if err := pdf.CopyPageAsCover(coverSrcPath, coverDest); err != nil {
			return err
		}
		if err := r.withSave(ctx, func() { book.CoverImagePath = &coverDest }); err != nil {
			return err
		}
		w.emit(book, map[string]any{"coverImagePath": coverDest})
	}

	if book.CoverImagePath != nil && strings.TrimSpace(book.Name) == "" {
		if err := w.setProgress(ctx, r, 0, 1, "Reading title…", model.StatusReadingTitle); err != nil {
			return err
		}
		if cover, err := os.ReadFile(*book.CoverImagePath); err == nil {
			if title, err := w.Q.ExtractTitle(ctx, cover); err == nil && title != "" {
				if err := r.withSave(ctx, func() { book.Name = title }); err != nil {
					return err
				}
				w.emit(book, map[string]any{"name": title})
			}
		}
	}

	if err := w.setProgress(ctx, r, 0, 1, "Detecting language…", model.StatusReadingTitle); err != nil {
		return err
	}
	if len(book.SummaryPages) > 0 {
		if image := readPage(book.FolderPath, book.SummaryPages[0]); image != nil {
			if language, err := w.Q.DetectLanguage(ctx, image); err == nil && language != "" && language != "unknown" {
				if err := r.withSave(ctx, func() { book.Language = &language }); err != nil {
					return err
				}
				w.emit(book, map[string]any{"language": language})
			}
		}
	}

	// On a resume we keep pages already read and only redo pending/failed
	// ones; a fresh run starts every page from scratch.
	resuming := resume && len(book.OcrPages) > 0
	if err := r.withSave(ctx, func() {
		if !resuming {
			pages := make([]model.OcrPage, 0, book.LastPage-book.FirstPage+1)
			for p := book.FirstPage; p <= book.LastPage; p++ {
				pages = append(pages, model.OcrPage{Page: p, Text: "", Language: "unknown", Status: model.OcrPending})
			}
			book.OcrPages = pages
		}
		book.Status = model.StatusOcrProcessing
	}); err != nil {
		return err
	}
	w.emit(book, map[string]any{"status": model.StatusOcrProcessing, "totalPages": totalPages, "ocrPages": book.OcrPages})

	allPagePaths, err := pdf.AllPagePaths(book.FolderPath)
	if err != nil {
		return err
	}

	// Pages become vlm-role tasks: every live QwenVL worker pulls the next
	// one as soon as it's free, so a faster server simply OCRs more pages.
	// OcrConcurrency bounds how many page images sit in the broker at once.
	if !w.Q.Registry.HasHealthy(queue.RoleVLM) {
		return fmt.Errorf("No VLM worker is online — start a QwenVL worker and try again.")
	}

	// Indices into book.ocrPages still needing OCR. Fresh run: every page.
	// Resume: only the ones not already complete.
	var worklist []int
	for i, p := range book.OcrPages {
		if p.Status != model.OcrComplete {
			worklist = append(worklist, i)
		}
	}
	totalPagesToRead := len(book.OcrPages)
	var doneCount atomic.Int64
	doneCount.Store(int64(totalPagesToRead - len(worklist)))

	_ = pool.Run(worklist, config.OcrConcurrency, func(i int, _ int) error {
		pageNum := book.OcrPages[i].Page
		if pageNum-1 >= len(allPagePaths) {
			return nil
		}
		image, readErr := os.ReadFile(allPagePaths[pageNum-1])

		_ = r.withSave(ctx, func() { book.OcrPages[i].Status = model.OcrProcessing })
		w.emit(book, map[string]any{"ocrPage": map[string]any{"page": pageNum, "status": model.OcrProcessing}})

		var result queue.OcrPageResult
		err := readErr
		if err == nil {
			result, err = w.Q.OcrPage(ctx, image)
		}
		if err == nil {
			reflowed := sentences.ReflowSentences(result.Content)
			readText := normalizer.NormalizeForSpeech(ctx, reflowed, BookSpeechLanguage(book, result.Language))
			r.locked(func() {
				book.OcrPages[i].Text = reflowed
				book.OcrPages[i].Language = result.Language
				book.OcrPages[i].ReadText = &readText
				book.OcrPages[i].Status = model.OcrComplete
				book.OcrPages[i].Error = nil
			})
		} else {
			message := err.Error()
			log.Printf("OCR failed for page %d of book %s: %s", pageNum, book.ID.Hex(), message)
			r.locked(func() {
				book.OcrPages[i].Status = model.OcrErr
				book.OcrPages[i].Error = &message
			})
		}

		done := doneCount.Add(1)
		_ = r.withSave(ctx, nil)
		r.locked(func() {
			page := book.OcrPages[i]
			w.emit(book, map[string]any{
				"progress": progressPayload{Current: int(done), Total: totalPagesToRead, Message: fmt.Sprintf("OCR page %d/%d…", pageNum, book.LastPage)},
				"ocrPage": map[string]any{
					"page": pageNum, "text": page.Text, "readText": page.ReadText,
					"status": page.Status, "error": page.Error,
				},
			})
		})
		return nil
	})

	if err := w.setProgress(ctx, r, 0, 1, "Detecting chapters…", model.StatusDetectingChapters); err != nil {
		return err
	}
	var completedPages []ocr.PageText
	for _, p := range book.OcrPages {
		if p.Status == model.OcrComplete {
			completedPages = append(completedPages, ocr.PageText{Page: p.Page, Text: sanitize.PageText(p.Text)})
		}
	}

	suggestions, err := w.DetectChapters(ctx, book, completedPages)
	if err != nil {
		return err
	}

	if err := r.withSave(ctx, func() {
		chapters := make([]model.Chapter, len(suggestions))
		for i, s := range suggestions {
			chapters[i] = model.Chapter{
				ID:        newObjectID(),
				Title:     s.Title,
				StartPage: s.Page,
				StartChar: s.StartChar,
				Sentences: []model.Sentence{},
				Tracks:    model.FreshTracks(book.Voices),
			}
		}
		book.Chapters = chapters
		book.Status = model.StatusAwaitingChapterReview
		book.Progress = model.Progress{Current: 0, Total: 0, Message: "Awaiting chapter review…"}
	}); err != nil {
		return err
	}
	w.emit(book, map[string]any{
		"status":   model.StatusAwaitingChapterReview,
		"progress": book.Progress,
		"chapters": book.Chapters,
	})
	return nil
}

// detectChapters ships every summary-page image to the vlm workers for TOC
// extraction (in parallel), then locates the merged entries in the OCR text.
func (w *Worker) DetectChapters(ctx context.Context, book *model.Book, completedPages []ocr.PageText) ([]ocr.ChapterSuggestion, error) {
	var images [][]byte
	for _, p := range book.SummaryPages {
		if image := readPage(book.FolderPath, p); image != nil {
			images = append(images, image)
		}
	}
	if len(images) == 0 {
		return nil, nil
	}
	tocLists := make([][]queue.TocEntry, len(images))
	err := pool.Run(images, len(images), func(image []byte, i int) error {
		entries, err := w.Q.ExtractToc(ctx, image)
		if err != nil {
			return err
		}
		tocLists[i] = entries
		return nil
	})
	if err != nil {
		return nil, err
	}
	converted := make([][]ocr.TocEntry, len(tocLists))
	for i, list := range tocLists {
		converted[i] = make([]ocr.TocEntry, len(list))
		for j, e := range list {
			converted[i][j] = ocr.TocEntry{Title: e.Title, Page: e.Page}
		}
	}
	return ocr.ResolveChapters(converted, completedPages), nil
}

// ReprocessPageOcr re-runs OCR for a single page, then marks the page's
// chapter audio stale so it gets regenerated.
func (w *Worker) ReprocessPageOcr(ctx context.Context, bookID string, pageNum int) error {
	release, ok := w.TryRun(bookID)
	if !ok {
		return fmt.Errorf("A generation run is in progress for this book — stop it before reprocessing pages.")
	}
	defer release()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	r := &run{w: w, book: book}

	pageIdx := -1
	for i, p := range book.OcrPages {
		if p.Page == pageNum {
			pageIdx = i
			break
		}
	}
	if pageIdx < 0 {
		return nil
	}

	if !w.Q.Registry.HasHealthy(queue.RoleVLM) {
		return fmt.Errorf("No VLM worker is online — start a QwenVL worker and try again.")
	}

	if err := r.withSave(ctx, func() {
		book.OcrPages[pageIdx].Status = model.OcrProcessing
		book.OcrPages[pageIdx].Error = nil
	}); err != nil {
		return err
	}
	w.emit(book, map[string]any{"ocrPage": map[string]any{"page": pageNum, "status": model.OcrProcessing}})

	allPagePaths, _ := pdf.AllPagePaths(book.FolderPath)
	imagePath := ""
	if pageNum-1 >= 0 && pageNum-1 < len(allPagePaths) {
		imagePath = allPagePaths[pageNum-1]
	}

	var ocrErr error
	if imagePath == "" {
		ocrErr = fmt.Errorf("Page image not found")
	} else {
		image, err := os.ReadFile(imagePath)
		var result queue.OcrPageResult
		if err == nil {
			result, err = w.Q.OcrPage(ctx, image)
		}
		if err != nil {
			ocrErr = err
		} else {
			reflowed := sentences.ReflowSentences(result.Content)
			readText := normalizer.NormalizeForSpeech(ctx, reflowed, BookSpeechLanguage(book, result.Language))
			r.locked(func() {
				book.OcrPages[pageIdx].Text = reflowed
				book.OcrPages[pageIdx].Language = result.Language
				book.OcrPages[pageIdx].ReadText = &readText
				book.OcrPages[pageIdx].Status = model.OcrComplete
				book.OcrPages[pageIdx].Error = nil
			})
		}
	}
	if ocrErr != nil {
		message := ocrErr.Error()
		log.Printf("Re-OCR failed for page %d of book %s: %s", pageNum, bookID, message)
		r.locked(func() {
			book.OcrPages[pageIdx].Status = model.OcrErr
			book.OcrPages[pageIdx].Error = &message
		})
	}

	anyStale := false
	if book.OcrPages[pageIdx].Status == model.OcrComplete {
		for i := range book.Chapters {
			chStart := book.Chapters[i].StartPage
			chEnd := book.LastPage
			if i+1 < len(book.Chapters) {
				chEnd = book.Chapters[i+1].StartPage
			}
			if pageNum >= chStart && pageNum <= chEnd {
				book.Chapters[i].Sentences = []model.Sentence{}
				for ti := range book.Chapters[i].Tracks {
					if book.Chapters[i].Tracks[ti].AudioStatus == model.AudioComplete {
						book.Chapters[i].Tracks[ti].AudioStatus = model.AudioStale
						anyStale = true
					}
				}
			}
		}
	}

	if err := r.withSave(ctx, nil); err != nil {
		return err
	}
	page := book.OcrPages[pageIdx]
	w.emit(book, map[string]any{
		"ocrPage": map[string]any{
			"page": pageNum, "text": page.Text, "readText": page.ReadText,
			"status": page.Status, "error": page.Error,
		},
	})
	if anyStale {
		w.emit(book, map[string]any{"chapters": book.Chapters})
	}
	return nil
}
