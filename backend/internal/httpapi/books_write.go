package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/kevynsax/book-reader/backend/internal/config"
	"github.com/kevynsax/book-reader/backend/internal/lib/sanitize"
	"github.com/kevynsax/book-reader/backend/internal/model"
	"github.com/kevynsax/book-reader/backend/internal/svc/normalizer"
	"github.com/kevynsax/book-reader/backend/internal/svc/ocr"
	"github.com/kevynsax/book-reader/backend/internal/svc/pdf"
	"github.com/kevynsax/book-reader/backend/internal/svc/tts"
	"github.com/kevynsax/book-reader/backend/internal/worker"
)

func bsonNewObjectID() bson.ObjectID { return bson.NewObjectID() }

func (s *Server) registerBookWriteRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/books", s.handleUpload)
	mux.HandleFunc("POST /api/books/{id}/reprocess", s.handleReprocess)
	mux.HandleFunc("POST /api/books/{id}/resume", s.handleResume)
	mux.HandleFunc("GET /api/books/{id}/sample", s.handleSample)
	mux.HandleFunc("GET /api/books/line-split/models", s.handleSlmModels)
	mux.HandleFunc("PUT /api/books/{id}/cover", s.handleCoverUpload)
	mux.HandleFunc("PUT /api/books/{id}/cover/page", s.handleCoverFromPage)
	mux.HandleFunc("POST /api/books/{id}/summary/detect", s.handleSummaryDetect)
	mux.HandleFunc("PATCH /api/books/{id}/chapters", s.handleChaptersPatch)
	mux.HandleFunc("PUT /api/books/{id}/chapters", s.handleChaptersPut)
	mux.HandleFunc("POST /api/books/{id}/generate", s.handleGenerate)
	mux.HandleFunc("POST /api/books/{id}/stop", s.handleStop)
	mux.HandleFunc("PUT /api/books/{id}/pages/{page}/text", s.handlePageText)
	mux.HandleFunc("POST /api/books/{id}/pages/{page}/reocr", s.handleReocr)
	mux.HandleFunc("POST /api/books/{id}/line-split", s.handleLineSplit)
	mux.HandleFunc("POST /api/books/{id}/line-typos", s.handleLineTypos)
	mux.HandleFunc("POST /api/books/{id}/chapters/{idx}/regenerate", s.handleChapterRegenerate)
	mux.HandleFunc("POST /api/books/{id}/reassemble", s.handleReassemble)
	mux.HandleFunc("POST /api/books/{id}/voices", s.handleAddVoices)
	mux.HandleFunc("DELETE /api/books/{id}/voices/{voice}", s.handleRemoveVoice)
	mux.HandleFunc("POST /api/books/{id}/voices/{voice}/regenerate", s.handleVoiceRegenerate)
	mux.HandleFunc("POST /api/books/{id}/chapters/{idx}/voices/{voice}/regenerate", s.handleChapterVoiceRegenerate)
	mux.HandleFunc("POST /api/books/{id}/chapters/{idx}/voices/{voice}/continue", s.handleChapterVoiceContinue)
	mux.HandleFunc("PUT /api/books/{id}/chapters/{idx}/sentences/{sentenceId}", s.handleSentenceEdit)
	mux.HandleFunc("DELETE /api/books/{id}/chapters/{idx}/sentences/{sentenceId}", s.handleSentenceDelete)
	mux.HandleFunc("POST /api/books/{id}/chapters/{idx}/sentences/{sentenceId}/regenerate", s.handleSentenceRegenerate)
}

// parseSummaryPages accepts the summary pages as a JSON array, a
// comma-separated string, or a single value, returning the unique positive
// page numbers in order.
func parseSummaryPages(raw string) []int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var values []any
	var parsed any
	if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
		if arr, ok := parsed.([]any); ok {
			values = arr
		} else {
			values = []any{parsed}
		}
	} else {
		for _, part := range strings.Split(raw, ",") {
			values = append(values, part)
		}
	}
	var out []int
	seen := map[int]bool{}
	for _, v := range values {
		n := 0
		switch x := v.(type) {
		case float64:
			if x == float64(int(x)) {
				n = int(x)
			}
		case string:
			n, _ = strconv.Atoi(strings.TrimSpace(x))
		}
		if n > 0 && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}

// saveUploadedFile spools one multipart file field to a temp file, enforcing
// the size limit and content-type filter, and returns the temp path.
func saveUploadedFile(r *http.Request, field string, maxBytes int64, typeOK func(string) bool) (string, error) {
	file, header, err := r.FormFile(field)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if !typeOK(header.Header.Get("Content-Type")) {
		return "", errBadType
	}
	tmp, err := os.CreateTemp("", "book-upload-")
	if err != nil {
		return "", err
	}
	defer tmp.Close()
	if _, err := io.Copy(tmp, io.LimitReader(file, maxBytes+1)); err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	if stat, err := tmp.Stat(); err == nil && stat.Size() > maxBytes {
		os.Remove(tmp.Name())
		return "", errTooLarge
	}
	return tmp.Name(), nil
}

var (
	errBadType  = &uploadError{"Only PDF files are allowed"}
	errTooLarge = &uploadError{"File too large"}
)

type uploadError struct{ msg string }

func (e *uploadError) Error() string { return e.msg }

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<30+(1<<20))
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		Error(w, http.StatusBadRequest, err.Error())
		return
	}
	defer r.MultipartForm.RemoveAll()

	tmpPath, err := saveUploadedFile(r, "file", 1<<30, func(ct string) bool { return ct == "application/pdf" })
	if err != nil {
		if _, ok := err.(*uploadError); ok {
			Error(w, http.StatusBadRequest, err.Error())
		} else {
			Error(w, http.StatusBadRequest, "No file uploaded")
		}
		return
	}
	defer os.Remove(tmpPath)

	form := r.MultipartForm.Value
	get := func(k string) string {
		if v := form[k]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	summaryRaw := get("summaryPages")
	if summaryRaw == "" {
		summaryRaw = get("summaryPage")
	}
	summary := parseSummaryPages(summaryRaw)
	coverPage, _ := strconv.Atoi(get("coverPage"))
	firstPage, _ := strconv.Atoi(get("firstPage"))
	lastPage, _ := strconv.Atoi(get("lastPage"))
	if len(summary) == 0 || coverPage == 0 || firstPage == 0 || lastPage == 0 {
		Error(w, http.StatusBadRequest, "Missing required fields")
		return
	}

	voice := get("voice")
	if voice == "" {
		voice = "chatterbox:pt-BR-FranciscaNeural"
	}

	booksDir := filepath.Join(config.DataDir, "books")
	if err := os.MkdirAll(booksDir, 0o755); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	book := &model.Book{
		Name:         strings.TrimSpace(get("name")),
		SummaryPages: summary,
		CoverPage:    coverPage,
		FirstPage:    firstPage,
		LastPage:     lastPage,
		Voices:       []string{voice},
		FolderPath:   "pending",
		FilePath:     "pending",
		Status:       model.StatusUploading,
		Progress:     model.Progress{},
	}
	if err := s.St.Books.Insert(r.Context(), book); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	bookID := book.ID.Hex()
	folderPath := filepath.Join(booksDir, bookID)
	filePath := filepath.Join(folderPath, "original.pdf")
	if err := os.MkdirAll(folderPath, 0o755); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := copyFile(tmpPath, filePath); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	book.FolderPath = folderPath
	book.FilePath = filePath
	if err := s.St.Books.Save(r.Context(), book); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]string{"bookId": bookID, "message": "Book uploaded. Processing started."})

	go func() {
		if err := s.W.ProcessBook(context.Background(), bookID, false); err != nil {
			log.Printf("processBook %s failed: %v", bookID, err)
		}
	}()
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func (s *Server) handleReprocess(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	if book.FilePath == "" || book.FilePath == "pending" || !fileExists(book.FilePath) {
		Error(w, http.StatusConflict, "Original PDF is no longer available")
		return
	}

	// Optional reconfiguration before restarting the import.
	var cfg struct {
		CoverPage    *int            `json:"coverPage"`
		FirstPage    *int            `json:"firstPage"`
		LastPage     *int            `json:"lastPage"`
		SummaryPages json.RawMessage `json:"summaryPages"`
	}
	_ = decodeJSON(r, &cfg)
	applyPage := func(v *int) int {
		if v != nil && *v > 0 {
			return *v
		}
		return 0
	}
	cover, first, last := applyPage(cfg.CoverPage), applyPage(cfg.FirstPage), applyPage(cfg.LastPage)
	var summary []int
	if cfg.SummaryPages != nil {
		summary = parseSummaryPages(string(cfg.SummaryPages))
	}
	if first != 0 && last != 0 && first > last {
		first, last = last, first
	}
	if cover != 0 {
		book.CoverPage = cover
	}
	if len(summary) > 0 {
		book.SummaryPages = summary
	}
	if first != 0 {
		book.FirstPage = first
	}
	if last != 0 {
		book.LastPage = last
	}

	release, ok := s.W.TryLockBook(book.ID.Hex())
	if !ok {
		Error(w, http.StatusConflict, "Audio generation is in progress — stop it before reprocessing.")
		return
	}
	defer release()

	book.Status = model.StatusSplittingPages
	book.ErrorMessage = nil
	book.Progress = model.Progress{Current: 0, Total: 1, Message: "Restarting import…"}
	book.Chapters = []model.Chapter{}
	book.OcrPages = []model.OcrPage{}
	if err := s.St.Books.Save(r.Context(), book); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	bookID := book.ID.Hex()
	s.Hub.Emit("book:update", map[string]any{
		"bookId":    bookID,
		"updatedAt": book.UpdatedAt,
		"status":    book.Status,
		"progress":  book.Progress,
		"chapters":  model.SerializeChaptersForClient(book.Chapters),
		"ocrPages":  book.OcrPages,
	})
	Message(w, "Reprocessing started.")

	go func() {
		if err := s.W.ProcessBook(context.Background(), bookID, false); err != nil {
			log.Printf("processBook %s failed: %v", bookID, err)
		}
	}()
}

func (s *Server) handleResume(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	if book.FilePath == "" || book.FilePath == "pending" || !fileExists(book.FilePath) {
		Error(w, http.StatusConflict, "Original PDF is no longer available")
		return
	}

	release, ok := s.W.TryLockBook(book.ID.Hex())
	if !ok {
		Error(w, http.StatusConflict, "A run is already in progress for this book.")
		return
	}
	defer release()

	if len(book.OcrPages) > 0 {
		book.Status = model.StatusOcrProcessing
	} else {
		book.Status = model.StatusSplittingPages
	}
	book.ErrorMessage = nil
	book.Progress = model.Progress{Current: 0, Total: 1, Message: "Resuming import…"}
	if err := s.St.Books.Save(r.Context(), book); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	bookID := book.ID.Hex()
	s.Hub.Emit("book:update", map[string]any{
		"bookId":       bookID,
		"updatedAt":    book.UpdatedAt,
		"status":       book.Status,
		"progress":     book.Progress,
		"errorMessage": "",
	})
	Message(w, "Resuming import.")

	go func() {
		if err := s.W.ProcessBook(context.Background(), bookID, true); err != nil {
			log.Printf("processBook (resume) %s failed: %v", bookID, err)
		}
	}()
}

// sampleText picks the first substantial paragraphs of readable text.
func sampleText(ocrPages []model.OcrPage, firstPage int) string {
	var pages []model.OcrPage
	for _, p := range ocrPages {
		if p.Status == model.OcrComplete && p.Page >= firstPage {
			pages = append(pages, p)
		}
	}
	sort.SliceStable(pages, func(i, j int) bool { return pages[i].Page < pages[j].Page })

	for _, p := range pages {
		var paragraphs []string
		for _, para := range strings.Split(sanitize.PageText(p.Text), "\n\n") {
			if s := strings.TrimSpace(para); s != "" {
				paragraphs = append(paragraphs, s)
			}
		}
		startIdx := -1
		for i, para := range paragraphs {
			if len(para) >= 40 {
				startIdx = i
				break
			}
		}
		if startIdx >= 0 {
			joined := strings.Join(paragraphs[startIdx:], "\n\n")
			if len(joined) >= 40 {
				return sliceChars(joined, 1500)
			}
		}
	}
	var all []string
	for _, p := range pages {
		all = append(all, sanitize.PageText(p.Text))
	}
	return sliceChars(strings.TrimSpace(strings.Join(all, " ")), 1500)
}

func sliceChars(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func (s *Server) handleSample(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	voice := r.URL.Query().Get("voice")
	if voice == "" && len(book.Voices) > 0 {
		voice = book.Voices[0]
	}
	if voice == "" {
		Error(w, http.StatusBadRequest, "voice is required")
		return
	}
	text := sampleText(book.OcrPages, book.FirstPage)
	if text == "" {
		Error(w, http.StatusConflict, "No readable text yet")
		return
	}
	audio, err := tts.SynthesizeSample(r.Context(), text, voice)
	if err != nil {
		Error(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(audio)
}

func (s *Server) handleSlmModels(w http.ResponseWriter, r *http.Request) {
	models, err := ocr.FetchSlmModels(r.Context())
	if err != nil {
		Error(w, http.StatusBadGateway, err.Error())
		return
	}
	JSON(w, http.StatusOK, models)
}

func (s *Server) handleCoverUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 20<<20+(1<<20))
	if err := r.ParseMultipartForm(4 << 20); err != nil {
		Error(w, http.StatusBadRequest, err.Error())
		return
	}
	defer r.MultipartForm.RemoveAll()

	book := s.findBook(w, r)
	if book == nil {
		return
	}
	tmpPath, err := saveUploadedFile(r, "image", 20<<20, func(ct string) bool { return strings.HasPrefix(ct, "image/") })
	if err != nil {
		if err == errBadType {
			Error(w, http.StatusBadRequest, "Only image files are allowed")
		} else {
			Error(w, http.StatusBadRequest, "No image uploaded")
		}
		return
	}
	defer os.Remove(tmpPath)

	coverDest := filepath.Join(book.FolderPath, "cover.jpg")
	if err := copyFile(tmpPath, coverDest); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	updatedAt, err := s.St.Books.UpdateByID(r.Context(), book.ID, bson.M{"$set": bson.M{"coverImagePath": coverDest}})
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.Hub.Emit("book:update", map[string]any{
		"bookId": book.ID.Hex(), "updatedAt": updatedAt, "coverImagePath": coverDest,
	})
	Message(w, "Cover updated")
}

func (s *Server) handleCoverFromPage(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	var body struct {
		Page int `json:"page"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Page == 0 {
		Error(w, http.StatusBadRequest, "page is required")
		return
	}
	imagePath := pdf.FindPageImagePath(book.FolderPath, body.Page)
	if imagePath == "" {
		Error(w, http.StatusNotFound, "Page not found")
		return
	}
	coverDest := filepath.Join(book.FolderPath, "cover.jpg")
	if err := pdf.CopyPageAsCover(imagePath, coverDest); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	updatedAt, err := s.St.Books.UpdateByID(r.Context(), book.ID, bson.M{"$set": bson.M{
		"coverImagePath": coverDest, "coverPage": body.Page,
	}})
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.Hub.Emit("book:update", map[string]any{
		"bookId": book.ID.Hex(), "updatedAt": updatedAt, "coverImagePath": coverDest,
	})
	Message(w, "Cover updated")
}

func (s *Server) handleSummaryDetect(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	hasImages := false
	for _, p := range book.SummaryPages {
		if pdf.FindPageImagePath(book.FolderPath, p) != "" {
			hasImages = true
			break
		}
	}
	if !hasImages {
		Error(w, http.StatusNotFound, "Summary page image not found")
		return
	}
	var completedPages []ocr.PageText
	for _, p := range book.OcrPages {
		if p.Status == model.OcrComplete {
			completedPages = append(completedPages, ocr.PageText{Page: p.Page, Text: sanitize.PageText(p.Text)})
		}
	}
	chapters, err := s.W.DetectChapters(r.Context(), book, completedPages)
	if err != nil {
		Error(w, http.StatusBadGateway, err.Error())
		return
	}
	if chapters == nil {
		chapters = []ocr.ChapterSuggestion{}
	}
	JSON(w, http.StatusOK, map[string]any{"summaryPages": book.SummaryPages, "chapters": chapters})
}

type chapterBody struct {
	Title     string `json:"title"`
	StartPage int    `json:"startPage"`
	StartChar int    `json:"startChar"`
}

// reconcileTracks keeps an unchanged chapter's tracks (segments included) for
// voices still on the book, and adds fresh pending tracks for new voices.
func reconcileTracks(chapter *model.Chapter, voices []string) []model.VoiceTrack {
	tracks := make([]model.VoiceTrack, 0, len(voices))
	for _, voice := range voices {
		found := false
		for _, t := range chapter.Tracks {
			if t.Voice == voice {
				tracks = append(tracks, t)
				found = true
				break
			}
		}
		if !found {
			tracks = append(tracks, model.VoiceTrack{Voice: voice, AudioStatus: model.AudioPending, Segments: []model.Segment{}})
		}
	}
	return tracks
}

// PATCH /:id/chapters — update chapter boundaries, mark affected tracks
// stale (no regeneration kicked off).
func (s *Server) handleChaptersPatch(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	var body struct {
		Chapters []chapterBody `json:"chapters"`
	}
	if err := decodeJSON(r, &body); err != nil || len(body.Chapters) == 0 {
		Error(w, http.StatusBadRequest, "chapters array is required")
		return
	}

	// Rebuilding chapters from this handler's snapshot while a run is saving
	// its own would erase the run's rendered segments; refuse instead.
	release, ok := s.W.TryLockBook(book.ID.Hex())
	if !ok {
		Error(w, http.StatusConflict, "Audio generation is in progress — stop it before editing chapters.")
		return
	}
	defer release()
	fresh, err := s.St.Books.FindByID(r.Context(), r.PathValue("id"))
	if err != nil || fresh == nil {
		Error(w, http.StatusNotFound, "Not found")
		return
	}
	book = fresh

	toRegen := map[int]bool{}
	for i, c := range body.Chapters {
		changed := i >= len(book.Chapters) ||
			book.Chapters[i].StartPage != c.StartPage ||
			book.Chapters[i].StartChar != c.StartChar
		if changed {
			toRegen[i] = true
			if i > 0 {
				toRegen[i-1] = true
			}
		}
	}

	nextChapters := make([]model.Chapter, len(body.Chapters))
	for i, c := range body.Chapters {
		var existing *model.Chapter
		if i < len(book.Chapters) {
			existing = &book.Chapters[i]
		}

		// A chapter whose boundaries didn't change keeps its split sentences
		// and rendered segments — the review save that precedes every
		// Generate/Continue click must not discard hours of synthesis. Only a
		// real startPage/startChar move invalidates the cached text.
		if existing != nil && !toRegen[i] {
			kept := *existing
			kept.Title = c.Title
			kept.Tracks = reconcileTracks(existing, book.Voices)
			nextChapters[i] = kept
			continue
		}

		tracks := make([]model.VoiceTrack, len(book.Voices))
		for vi, voice := range book.Voices {
			var prev *model.VoiceTrack
			if existing != nil {
				prev = book.TrackForVoice(existing, voice)
			}
			track := model.VoiceTrack{Voice: voice, AudioStatus: model.AudioPending, Segments: []model.Segment{}}
			if prev != nil {
				track.AudioPath = prev.AudioPath
				track.AudioDurationSecs = prev.AudioDurationSecs
				if prev.AudioStatus == model.AudioComplete {
					track.AudioStatus = model.AudioStale
				}
			}
			tracks[vi] = track
		}
		nextChapters[i] = model.Chapter{
			ID: bsonNewObjectID(), Title: c.Title, StartPage: c.StartPage, StartChar: c.StartChar,
			Sentences: []model.Sentence{}, Tracks: tracks,
		}
	}

	if err := s.St.Books.SetChapters(r.Context(), book.ID, nextChapters); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	updated, err := s.St.Books.FindByID(r.Context(), r.PathValue("id"))
	if err != nil || updated == nil {
		Error(w, http.StatusNotFound, "Not found")
		return
	}
	s.Hub.Emit("book:update", map[string]any{
		"bookId": updated.ID.Hex(), "updatedAt": updated.UpdatedAt, "chapters": updated.Chapters,
	})
	Message(w, "Chapters updated")
}

// PUT /:id/chapters — confirm chapters (+ voices), then start audio gen.
// Chapters whose boundaries didn't move keep their split sentences and
// rendered segments, same as PATCH — re-confirming must never discard
// finished synthesis.
func (s *Server) handleChaptersPut(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	var body struct {
		Chapters []chapterBody `json:"chapters"`
		Voice    string        `json:"voice"`
		Voices   []string      `json:"voices"`
	}
	if err := decodeJSON(r, &body); err != nil || len(body.Chapters) == 0 {
		Error(w, http.StatusBadRequest, "chapters array is required")
		return
	}

	release, ok := s.W.TryLockBook(book.ID.Hex())
	if !ok {
		Error(w, http.StatusConflict, "Audio generation is in progress — stop it before confirming chapters.")
		return
	}
	defer release()
	fresh, err := s.St.Books.FindByID(r.Context(), r.PathValue("id"))
	if err != nil || fresh == nil {
		Error(w, http.StatusNotFound, "Not found")
		return
	}
	book = fresh

	requested := body.Voices
	if len(requested) == 0 && body.Voice != "" {
		requested = []string{body.Voice}
	}
	var voices []string
	seen := map[string]bool{}
	for _, v := range requested {
		v = strings.TrimSpace(v)
		if v != "" && !seen[v] {
			seen[v] = true
			voices = append(voices, v)
		}
	}
	if len(voices) > 0 {
		book.Voices = voices
	}

	chapters := make([]model.Chapter, len(body.Chapters))
	for i, c := range body.Chapters {
		var existing *model.Chapter
		if i < len(book.Chapters) {
			existing = &book.Chapters[i]
		}
		unchanged := existing != nil &&
			existing.StartPage == c.StartPage && existing.StartChar == c.StartChar &&
			(i+1 < len(body.Chapters)) == (i+1 < len(book.Chapters))
		if unchanged && i+1 < len(body.Chapters) {
			unchanged = book.Chapters[i+1].StartPage == body.Chapters[i+1].StartPage &&
				book.Chapters[i+1].StartChar == body.Chapters[i+1].StartChar
		}
		if unchanged {
			kept := *existing
			kept.Title = c.Title
			kept.Tracks = reconcileTracks(existing, book.Voices)
			chapters[i] = kept
			continue
		}
		chapters[i] = model.Chapter{
			ID: bsonNewObjectID(), Title: c.Title, StartPage: c.StartPage, StartChar: c.StartChar,
			Sentences: []model.Sentence{}, Tracks: model.FreshTracks(book.Voices),
		}
	}
	book.Chapters = chapters

	updatedAt, err := s.St.Books.UpdateByID(r.Context(), book.ID, bson.M{"$set": bson.M{
		"chapters": book.Chapters, "voices": book.Voices,
	}})
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.Hub.Emit("book:update", map[string]any{
		"bookId": book.ID.Hex(), "updatedAt": updatedAt,
		"voices": book.Voices, "chapters": model.SerializeChaptersForClient(book.Chapters),
	})
	Message(w, "Chapters saved. Audio generation started.")

	bookID := book.ID.Hex()
	go func() {
		if err := s.W.GenerateBookAudio(context.Background(), bookID); err != nil {
			log.Printf("generateBookAudio %s failed: %v", bookID, err)
		}
	}()
}

func (s *Server) handleGenerate(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	if len(book.Chapters) == 0 {
		Error(w, http.StatusBadRequest, "No chapters to generate")
		return
	}
	Message(w, "Generation started")
	bookID := book.ID.Hex()
	go func() {
		if err := s.W.GenerateBookAudio(context.Background(), bookID); err != nil {
			log.Printf("generateBookAudio %s failed: %v", bookID, err)
		}
	}()
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	ok, err := s.W.StopBookAudio(r.Context(), book.ID.Hex())
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		Error(w, http.StatusNotFound, "Not found")
		return
	}
	Message(w, "Stopping audio generation…")
}

func (s *Server) handlePageText(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	pageNum, _ := strconv.Atoi(r.PathValue("page"))
	var body struct {
		Text *string `json:"text"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Text == nil {
		Error(w, http.StatusBadRequest, "text is required")
		return
	}

	release, ok := s.W.TryLockBook(book.ID.Hex())
	if !ok {
		Error(w, http.StatusConflict, "Audio generation is in progress — stop it before editing page text.")
		return
	}
	defer release()
	fresh, err := s.St.Books.FindByID(r.Context(), r.PathValue("id"))
	if err != nil || fresh == nil {
		Error(w, http.StatusNotFound, "Not found")
		return
	}
	book = fresh

	pageIdx := -1
	for i, p := range book.OcrPages {
		if p.Page == pageNum {
			pageIdx = i
			break
		}
	}
	if pageIdx < 0 {
		Error(w, http.StatusNotFound, "Page not found")
		return
	}

	text := *body.Text
	readText := normalizer.NormalizeForSpeech(r.Context(), text, worker.BookSpeechLanguage(book, book.OcrPages[pageIdx].Language))
	book.OcrPages[pageIdx].Text = text
	book.OcrPages[pageIdx].ReadText = &readText

	anyStale := false
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

	if err := s.St.Books.Save(r.Context(), book); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.Hub.Emit("book:update", map[string]any{
		"bookId": book.ID.Hex(), "updatedAt": book.UpdatedAt,
		"ocrPage": map[string]any{"page": pageNum, "text": text, "readText": readText, "status": "complete"},
	})
	if anyStale {
		s.Hub.Emit("book:update", map[string]any{
			"bookId": book.ID.Hex(), "chapters": book.Chapters,
		})
	}
	Message(w, "Saved")
}

func (s *Server) handleReocr(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	pageNum, _ := strconv.Atoi(r.PathValue("page"))
	found := false
	for _, p := range book.OcrPages {
		if p.Page == pageNum {
			found = true
			break
		}
	}
	if !found {
		Error(w, http.StatusNotFound, "Page not found")
		return
	}
	Message(w, "Re-OCR started.")
	bookID := book.ID.Hex()
	go func() {
		if err := s.W.ReprocessPageOcr(context.Background(), bookID, pageNum); err != nil {
			log.Printf("reprocessPageOcr %s page %d failed: %v", bookID, pageNum, err)
		}
	}()
}

func (s *Server) handleLineSplit(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	var body struct {
		Line  string `json:"line"`
		Model string `json:"model"`
	}
	if err := decodeJSON(r, &body); err != nil || strings.TrimSpace(body.Line) == "" {
		Error(w, http.StatusBadRequest, "line is required")
		return
	}
	split, err := ocr.SplitLineIntoSentences(r.Context(), strings.TrimSpace(sanitize.PageText(body.Line)), body.Model)
	if err != nil {
		Error(w, http.StatusBadGateway, err.Error())
		return
	}
	if split == nil {
		Error(w, http.StatusUnprocessableEntity, "No sentence split found")
		return
	}
	JSON(w, http.StatusOK, split)
}

func (s *Server) handleLineTypos(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	var body struct {
		Line  string `json:"line"`
		Model string `json:"model"`
	}
	if err := decodeJSON(r, &body); err != nil || strings.TrimSpace(body.Line) == "" {
		Error(w, http.StatusBadRequest, "line is required")
		return
	}
	corrected, err := ocr.ReviewLineGrammar(r.Context(), strings.TrimSpace(sanitize.PageText(body.Line)), body.Model)
	if err != nil {
		Error(w, http.StatusBadGateway, err.Error())
		return
	}
	JSON(w, http.StatusOK, map[string]string{"corrected": corrected})
}

func (s *Server) handleChapterRegenerate(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	idx, _ := strconv.Atoi(r.PathValue("idx"))
	if idx < 0 || idx >= len(book.Chapters) {
		Error(w, http.StatusNotFound, "Chapter not found")
		return
	}
	Message(w, "Regeneration started")

	bookID := book.ID.Hex()
	go func() {
		if err := s.W.RegenerateChapterAudio(context.Background(), bookID, idx); err != nil {
			log.Printf("regenerateChapterAudio %s ch%d failed: %v", bookID, idx, err)
		}
	}()
}

func (s *Server) handleReassemble(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	Message(w, "Reassembly started")
	bookID := book.ID.Hex()
	go func() {
		if err := s.W.ReassembleBookAudio(context.Background(), bookID); err != nil {
			log.Printf("reassembleBookAudio %s failed: %v", bookID, err)
		}
	}()
}

func (s *Server) handleAddVoices(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	var body struct {
		Voice  string   `json:"voice"`
		Voices []string `json:"voices"`
	}
	_ = decodeJSON(r, &body)
	requested := body.Voices
	if len(requested) == 0 && body.Voice != "" {
		requested = []string{body.Voice}
	}
	var unique []string
	seen := map[string]bool{}
	for _, v := range requested {
		v = strings.TrimSpace(v)
		if v != "" && !seen[v] {
			seen[v] = true
			unique = append(unique, v)
		}
	}
	if len(unique) == 0 {
		Error(w, http.StatusBadRequest, "voice is required")
		return
	}
	var toAdd []string
	for _, v := range unique {
		exists := false
		for _, existing := range book.Voices {
			if existing == v {
				exists = true
				break
			}
		}
		if !exists {
			toAdd = append(toAdd, v)
		}
	}
	if len(toAdd) == 0 {
		Error(w, http.StatusConflict, "Voice already added")
		return
	}

	release, ok := s.W.TryLockBook(book.ID.Hex())
	if !ok {
		Error(w, http.StatusConflict, "Audio generation is in progress — wait for it to finish (or stop it) before adding voices.")
		return
	}
	defer release()
	fresh, err := s.St.Books.FindByID(r.Context(), r.PathValue("id"))
	if err != nil || fresh == nil {
		Error(w, http.StatusNotFound, "Not found")
		return
	}
	book = fresh

	for _, voice := range toAdd {
		book.Voices = append(book.Voices, voice)
		for ci := range book.Chapters {
			if book.TrackForVoice(&book.Chapters[ci], voice) == nil {
				book.Chapters[ci].Tracks = append(book.Chapters[ci].Tracks,
					model.VoiceTrack{Voice: voice, AudioStatus: model.AudioPending, Segments: []model.Segment{}})
			}
		}
	}
	if err := s.St.Books.Save(r.Context(), book); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.Hub.Emit("book:update", map[string]any{
		"bookId": book.ID.Hex(), "updatedAt": book.UpdatedAt,
		"voices": book.Voices, "chapters": model.SerializeChaptersForClient(book.Chapters),
	})
	Message(w, fmt.Sprintf("%d voice(s) added. Generation started.", len(toAdd)))

	bookID := book.ID.Hex()
	go func() {
		if err := s.W.GenerateVoiceAudio(context.Background(), bookID, toAdd); err != nil {
			log.Printf("generateVoiceAudio %s %s failed: %v", bookID, strings.Join(toAdd, ", "), err)
		}
	}()
}

func (s *Server) handleRemoveVoice(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	voice := r.PathValue("voice")
	hasVoice := false
	for _, v := range book.Voices {
		if v == voice {
			hasVoice = true
			break
		}
	}
	if !hasVoice {
		Error(w, http.StatusNotFound, "Voice not found")
		return
	}

	release, ok := s.W.TryLockBook(book.ID.Hex())
	if !ok {
		Error(w, http.StatusConflict, "Audio generation is in progress — stop it before removing a voice.")
		return
	}
	defer release()
	fresh, err := s.St.Books.FindByID(r.Context(), r.PathValue("id"))
	if err != nil || fresh == nil {
		Error(w, http.StatusNotFound, "Not found")
		return
	}
	book = fresh

	audioDir := filepath.Join(book.FolderPath, "audio")
	for idx := range book.Chapters {
		chapter := &book.Chapters[idx]
		if track := book.TrackForVoice(chapter, voice); track != nil && track.AudioPath != nil {
			os.Remove(*track.AudioPath)
		}
		os.RemoveAll(worker.SegmentDir(audioDir, idx, voice))
		kept := make([]model.VoiceTrack, 0, len(chapter.Tracks))
		for _, t := range chapter.Tracks {
			if t.Voice != voice {
				kept = append(kept, t)
			}
		}
		chapter.Tracks = kept
	}
	var keptVoices []string
	for _, v := range book.Voices {
		if v != voice {
			keptVoices = append(keptVoices, v)
		}
	}
	book.Voices = keptVoices

	if err := s.St.Books.Save(r.Context(), book); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.Hub.Emit("book:update", map[string]any{
		"bookId": book.ID.Hex(), "updatedAt": book.UpdatedAt,
		"voices": book.Voices, "chapters": model.SerializeChaptersForClient(book.Chapters),
	})
	Message(w, "Voice removed")
}

func (s *Server) handleVoiceRegenerate(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	voice := r.PathValue("voice")
	found := false
	for _, v := range book.Voices {
		if v == voice {
			found = true
			break
		}
	}
	if !found {
		Error(w, http.StatusNotFound, "Voice not found")
		return
	}
	Message(w, "Voice regeneration started")

	bookID := book.ID.Hex()
	go func() {
		if err := s.W.RegenerateVoiceAudio(context.Background(), bookID, voice); err != nil {
			log.Printf("regenerateVoiceAudio %s %s failed: %v", bookID, voice, err)
		}
	}()
}

// chapterVoiceAction validates and dispatches; it deliberately writes nothing.
// The route used to flip the track to 'generating' and Save its own full copy
// of the book, which erased every segment an in-flight run had rendered since
// this handler loaded it — the worker owns all state changes now and emits
// 'generating' as soon as the run picks the chapter up.
func (s *Server) chapterVoiceAction(w http.ResponseWriter, r *http.Request, message string, action func(bookID string, idx int, voice string)) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	idx, _ := strconv.Atoi(r.PathValue("idx"))
	if idx < 0 || idx >= len(book.Chapters) {
		Error(w, http.StatusNotFound, "Chapter not found")
		return
	}
	voice := r.PathValue("voice")
	found := false
	for _, v := range book.Voices {
		if v == voice {
			found = true
			break
		}
	}
	if !found {
		Error(w, http.StatusNotFound, "Voice not found")
		return
	}
	Message(w, message)
	action(book.ID.Hex(), idx, voice)
}

func (s *Server) handleChapterVoiceRegenerate(w http.ResponseWriter, r *http.Request) {
	s.chapterVoiceAction(w, r, "Regeneration started", func(bookID string, idx int, voice string) {
		go func() {
			if err := s.W.RegenerateChapterVoiceAudio(context.Background(), bookID, idx, voice); err != nil {
				log.Printf("regenerateChapterVoiceAudio %s ch%d %s failed: %v", bookID, idx, voice, err)
			}
		}()
	})
}

func (s *Server) handleChapterVoiceContinue(w http.ResponseWriter, r *http.Request) {
	s.chapterVoiceAction(w, r, "Continue started", func(bookID string, idx int, voice string) {
		go func() {
			if err := s.W.ContinueChapterVoiceAudio(context.Background(), bookID, idx, voice); err != nil {
				log.Printf("continueChapterVoiceAudio %s ch%d %s failed: %v", bookID, idx, voice, err)
			}
		}()
	})
}

func (s *Server) sentenceRoutePrologue(w http.ResponseWriter, r *http.Request) (*model.Book, int, string, bool) {
	book := s.findBook(w, r)
	if book == nil {
		return nil, 0, "", false
	}
	idx, _ := strconv.Atoi(r.PathValue("idx"))
	if idx < 0 || idx >= len(book.Chapters) {
		Error(w, http.StatusNotFound, "Chapter not found")
		return nil, 0, "", false
	}
	sentenceID := r.PathValue("sentenceId")
	for _, s := range book.Chapters[idx].Sentences {
		if s.ID.Hex() == sentenceID {
			return book, idx, sentenceID, true
		}
	}
	Error(w, http.StatusNotFound, "Sentence not found")
	return nil, 0, "", false
}

func (s *Server) handleSentenceEdit(w http.ResponseWriter, r *http.Request) {
	book, idx, sentenceID, ok := s.sentenceRoutePrologue(w, r)
	if !ok {
		return
	}
	var body struct {
		Text string `json:"text"`
	}
	if err := decodeJSON(r, &body); err != nil || strings.TrimSpace(body.Text) == "" {
		Error(w, http.StatusBadRequest, "text is required")
		return
	}
	Message(w, "Sentence updated. Re-rendering audio.")
	bookID := book.ID.Hex()
	text := strings.TrimSpace(body.Text)
	go func() {
		if err := s.W.EditSentence(context.Background(), bookID, idx, sentenceID, text); err != nil {
			log.Printf("editSentence %s ch%d %s failed: %v", bookID, idx, sentenceID, err)
		}
	}()
}

func (s *Server) handleSentenceDelete(w http.ResponseWriter, r *http.Request) {
	book, idx, sentenceID, ok := s.sentenceRoutePrologue(w, r)
	if !ok {
		return
	}
	if len(book.Chapters[idx].Sentences) <= 1 {
		Error(w, http.StatusBadRequest, "Cannot delete the only sentence in a chapter")
		return
	}
	Message(w, "Sentence deleted. Reassembling audio.")
	bookID := book.ID.Hex()
	go func() {
		if err := s.W.DeleteSentence(context.Background(), bookID, idx, sentenceID); err != nil {
			log.Printf("deleteSentence %s ch%d %s failed: %v", bookID, idx, sentenceID, err)
		}
	}()
}

func (s *Server) handleSentenceRegenerate(w http.ResponseWriter, r *http.Request) {
	book, idx, sentenceID, ok := s.sentenceRoutePrologue(w, r)
	if !ok {
		return
	}
	var body struct {
		Voice string `json:"voice"`
	}
	_ = decodeJSON(r, &body)
	Message(w, "Re-rendering sentence.")
	bookID := book.ID.Hex()
	voice := body.Voice
	go func() {
		if err := s.W.RegenerateSegment(context.Background(), bookID, idx, sentenceID, voice); err != nil {
			log.Printf("regenerateSegment %s ch%d %s failed: %v", bookID, idx, sentenceID, err)
		}
	}()
}
