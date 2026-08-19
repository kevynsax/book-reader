package worker

import (
	"context"
	"fmt"
	"log"
	"sort"
	"sync/atomic"

	"github.com/kevynsax/book-reader/backend/internal/config"
	"github.com/kevynsax/book-reader/backend/internal/lib/pool"
	"github.com/kevynsax/book-reader/backend/internal/model"
)

// GenerateBookSentences runs the sentence phase: every chapter's text is
// split into TTS-ready sentences (SLM work, served by the split cache when
// the import prefetched it) and the book lands on awaiting_sentence_review —
// no audio is rendered. Honors the cooperative stop flag between chapters.
func (w *Worker) GenerateBookSentences(ctx context.Context, bookID string) error {
	release, ok := w.TryRun(bookID)
	if !ok {
		log.Printf("generateBookSentences %s: a run is already in flight; ignoring", bookID)
		return nil
	}
	defer release()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	r := &run{w: w, book: book}

	w.ensureBookLanguage(ctx, r)

	if err := w.setProgress(ctx, r, 0, len(book.Chapters), "Splitting sentences…", model.StatusGeneratingSentences); err != nil {
		return err
	}

	for idx := range book.Chapters {
		if w.stopRequested(bookID) {
			break
		}
		if ok, err := w.ensureSentences(ctx, r, idx); err != nil {
			message := err.Error()
			_ = r.withSave(ctx, func() {
				book.Status = model.StatusError
				book.ErrorMessage = &message
			})
			w.emit(book, map[string]any{"status": model.StatusError, "errorMessage": message})
			return err
		} else if ok {
			w.classifyChapterRoles(ctx, r, idx)
		}
		if err := w.setProgress(ctx, r, idx+1, len(book.Chapters),
			fmt.Sprintf("Splitting sentences %d/%d…", idx+1, len(book.Chapters)), ""); err != nil {
			return err
		}
	}

	if err := r.withSave(ctx, func() {
		book.Status = model.StatusAwaitingSentenceReview
		book.Progress = model.Progress{Current: len(book.Chapters), Total: len(book.Chapters), Message: "Sentences ready for review"}
		book.ErrorMessage = nil
	}); err != nil {
		return err
	}
	w.emit(book, map[string]any{"status": book.Status, "progress": book.Progress})
	return nil
}

// classifyChapterRoles asks the SLM who speaks each quote-flagged sentence of
// a chapter (deterministic quote detection already happened at build time —
// the SLM only refines the speaker, it never invents quotes). Sentences whose
// role a human or migration already refined are left alone.
func (w *Worker) classifyChapterRoles(ctx context.Context, r *run, idx int) {
	if !config.RoleClassify {
		return
	}
	book := r.book
	chapter := &book.Chapters[idx]

	ordered := append([]model.Sentence(nil), chapter.Sentences...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })
	display := func(s model.Sentence) string {
		if s.Display != nil && *s.Display != "" {
			return *s.Display
		}
		return s.Text
	}

	var targets []int
	for i, s := range ordered {
		if s.Role == model.RoleQuoteDefault {
			targets = append(targets, i)
		}
	}
	if len(targets) == 0 {
		return
	}

	msg := fmt.Sprintf("Identifying speakers in %q…", chapter.Title)
	w.emit(book, map[string]any{"classifyProgress": progressPayload{Current: 0, Total: len(targets), Message: msg}})
	roles := make([]model.SentenceRole, len(targets))
	var done atomic.Int64
	_ = pool.Run(targets, config.SentenceSplitConcurrency, func(oi int, ti int) error {
		var before, after []string
		for k := max(0, oi-2); k < oi; k++ {
			before = append(before, display(ordered[k]))
		}
		for k := oi + 1; k <= min(len(ordered)-1, oi+2); k++ {
			after = append(after, display(ordered[k]))
		}
		speaker, err := w.Q.ClassifyQuote(ctx, before, display(ordered[oi]), after, config.SlmSplitModel)
		if err != nil {
			log.Printf("classifyChapterRoles %s ch%d: %v", book.ID.Hex(), idx+1, err)
			speaker = "unknown"
		}
		switch speaker {
		case "man":
			roles[ti] = model.RoleQuoteMale
		case "woman":
			roles[ti] = model.RoleQuoteFemale
		case "kid":
			roles[ti] = model.RoleQuoteChild
		case "none":
			roles[ti] = model.RoleNone
		default:
			roles[ti] = model.RoleQuoteDefault
		}
		w.emit(book, map[string]any{"classifyProgress": progressPayload{Current: int(done.Add(1)), Total: len(targets), Message: msg}})
		return nil
	})
	if ctx.Err() != nil {
		return
	}

	byID := map[string]model.SentenceRole{}
	for ti, oi := range targets {
		byID[ordered[oi].ID.Hex()] = roles[ti]
	}
	if err := r.withSave(ctx, func() {
		for i := range chapter.Sentences {
			if role, ok := byID[chapter.Sentences[i].ID.Hex()]; ok {
				chapter.Sentences[i].Role = role
			}
		}
	}); err != nil {
		log.Printf("classifyChapterRoles %s ch%d save: %v", book.ID.Hex(), idx+1, err)
	}
}
