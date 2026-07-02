package worker

import (
	"context"
	"errors"
	"log"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/kevynsax/book-reader/backend-go/internal/model"
)

// ErrStopped unwinds a generation run cooperatively at the next
// chapter/segment boundary (Node's AudioStopped). In-flight renders complete
// and their files are kept — stop is a boundary check, not a cancellation.
var ErrStopped = errors.New("audio generation stopped")

func (w *Worker) stopRequested(bookID string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.stops[bookID]
}

// tryClaim registers a generation run for the book; false when one is
// already in flight (a Continue click can't spawn a second concurrent run).
func (w *Worker) tryClaim(bookID string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.active[bookID] {
		return false
	}
	w.active[bookID] = true
	return true
}

func (w *Worker) releaseClaim(bookID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.active, bookID)
	delete(w.stops, bookID)
}

// StopBookAudio stops audio generation for a book. A live job in this process
// unwinds cooperatively at the next boundary, keeping rendered chapters
// intact. If nothing is running here — e.g. the server restarted and lost the
// in-memory job while the DB still shows tracks mid-render — clean the stuck
// state directly so it becomes resumable. Errored tracks are cleared too so a
// stop also wipes errors. Returns false only when the book no longer exists.
func (w *Worker) StopBookAudio(ctx context.Context, bookID string) (bool, error) {
	w.mu.Lock()
	if w.active[bookID] {
		w.stops[bookID] = true
		w.mu.Unlock()
		return true, nil
	}
	w.mu.Unlock()

	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil {
		return false, err
	}
	if book == nil {
		return false, nil
	}
	r := &run{w: w, book: book}
	manage := book.Status == model.StatusGeneratingAudio || book.Status == model.StatusError
	return true, w.finalizeStop(ctx, r, manage, true)
}

// finalizeStop returns the book to a resumable, listenable state after a
// stop: finished chapters stay playable and the rest flip to 'stale' so they
// read as "needs generating" instead of forever mid-render.
func (w *Worker) finalizeStop(ctx context.Context, r *run, manageBookStatus, clearErrors bool) error {
	book := r.book
	err := r.withSave(ctx, func() {
		for ci := range book.Chapters {
			for ti := range book.Chapters[ci].Tracks {
				track := &book.Chapters[ci].Tracks[ti]
				if track.AudioStatus == model.AudioPending || track.AudioStatus == model.AudioGenerating ||
					(clearErrors && track.AudioStatus == model.AudioError) {
					track.AudioStatus = model.AudioStale
					if clearErrors {
						track.AudioError = nil
					}
				}
				for si := range track.Segments {
					if track.Segments[si].AudioStatus == model.AudioGenerating {
						track.Segments[si].AudioStatus = model.AudioPending
					}
				}
			}
		}
		if clearErrors {
			book.ErrorMessage = nil
		}
		if manageBookStatus {
			book.Status = model.StatusComplete
			book.Progress.Message = "Stopped."
		}
	})
	if err != nil {
		return err
	}

	update := map[string]any{
		"chapters": model.SerializeChaptersForClient(book.Chapters),
	}
	if manageBookStatus {
		update["status"] = model.StatusComplete
		update["progress"] = book.Progress
	}
	if clearErrors {
		update["errorMessage"] = ""
	}
	w.emit(book, update)
	return nil
}

// RecoverInterruptedAudio unsticks any audio job a crash/restart left
// mid-flight, mirroring a user Stop — finished chapters stay playable and the
// rest go 'stale' — so a single Generate resumes them from the segments
// already on disk. Purely a status reconciliation: no audio files touched.
func (w *Worker) RecoverInterruptedAudio(ctx context.Context) error {
	books, err := w.St.Books.Find(ctx, bson.M{
		"deleted": bson.M{"$ne": true},
		"$or": bson.A{
			bson.M{"status": "generating_audio"},
			bson.M{"chapters.tracks.audioStatus": "generating"},
			bson.M{"chapters.tracks.segments.audioStatus": "generating"},
		},
	}, nil)
	if err != nil {
		return err
	}
	for _, book := range books {
		r := &run{w: w, book: book}
		if err := w.finalizeStop(ctx, r, book.Status == model.StatusGeneratingAudio, false); err != nil {
			return err
		}
		name := book.Name
		if name == "" {
			name = book.ID.Hex()
		}
		log.Printf("Recovered interrupted audio for %q", name)
	}
	return nil
}
