package worker

import (
	"context"
	"fmt"
	"log"

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
		if _, err := w.ensureSentences(ctx, r, idx); err != nil {
			message := err.Error()
			_ = r.withSave(ctx, func() {
				book.Status = model.StatusError
				book.ErrorMessage = &message
			})
			w.emit(book, map[string]any{"status": model.StatusError, "errorMessage": message})
			return err
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
