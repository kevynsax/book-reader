package worker

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/kevynsax/book-reader/backend/internal/model"
	"github.com/kevynsax/book-reader/backend/internal/svc/tts"
)

// How long a recovered run waits for its TTS workers to re-register before
// giving up — a deploy takes a couple of minutes, a dead server never comes.
const resumeWaitLimit = 15 * time.Minute

// ErrStopped unwinds a generation run cooperatively at the next
// chapter/segment boundary (Node's AudioStopped). In-flight renders complete
// and their files are kept — stop is a boundary check, not a cancellation.
var ErrStopped = errors.New("audio generation stopped")

func (w *Worker) stopRequested(bookID string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.stops[bookID]
}

// bookLock returns the per-book mutex that serializes every load-mutate-save
// flow. Two flows on the same book each hold their own in-memory copy; if
// their saves interleave, whichever writes last silently erases the other's
// finished segments — this is how a Continue click while a run was in flight
// used to restart hours of rendering.
func (w *Worker) bookLock(bookID string) *sync.Mutex {
	w.mu.Lock()
	defer w.mu.Unlock()
	lock, ok := w.locks[bookID]
	if !ok {
		lock = &sync.Mutex{}
		w.locks[bookID] = lock
	}
	return lock
}

// TryRun claims the book for a generation/import run. False when the book is
// busy — the caller must SKIP, never interleave: the pending work is already
// covered by the run that holds the claim (its worklist re-checks track
// statuses), and a second run's saves would erase the first's progress.
func (w *Worker) TryRun(bookID string) (release func(), ok bool) {
	lock := w.bookLock(bookID)
	if !lock.TryLock() {
		return nil, false
	}
	w.mu.Lock()
	w.active[bookID] = true
	w.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			w.mu.Lock()
			delete(w.active, bookID)
			delete(w.stops, bookID)
			w.mu.Unlock()
			lock.Unlock()
		})
	}, true
}

// TryLockBook briefly claims the book for a route-side rewrite (chapter
// confirm, page-text edit, voice add) without marking a run active. False
// while a generation run holds the book — those routes answer 409 instead of
// corrupting the run's state.
// The release func is idempotent so handlers can release explicitly before
// spawning a follow-up run goroutine and still keep a defer as the safety net.
func (w *Worker) TryLockBook(bookID string) (release func(), ok bool) {
	lock := w.bookLock(bookID)
	if !lock.TryLock() {
		return nil, false
	}
	var once sync.Once
	return func() { once.Do(lock.Unlock) }, true
}

// LockBook waits for the book (used by short operations like sentence edits
// that should queue behind an active run rather than fail or interleave).
func (w *Worker) LockBook(bookID string) func() {
	lock := w.bookLock(bookID)
	lock.Lock()
	return lock.Unlock
}

// IsBookBusy reports whether a generation/import run currently holds the book.
func (w *Worker) IsBookBusy(bookID string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.active[bookID]
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

	unlock := w.LockBook(bookID)
	defer unlock()

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
			book.ResumeAudio = false
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
	var resume []*model.Book
	for _, book := range books {
		wasGenerating := book.Status == model.StatusGeneratingAudio
		unlock := w.LockBook(book.ID.Hex())
		r := &run{w: w, book: book}
		err := w.finalizeStop(ctx, r, wasGenerating, false)
		if err == nil && wasGenerating {
			err = r.withSave(ctx, func() { book.ResumeAudio = true })
		}
		unlock()
		if err != nil {
			return err
		}
		name := book.Name
		if name == "" {
			name = book.ID.Hex()
		}
		log.Printf("Recovered interrupted audio for %q", name)
		if wasGenerating {
			resume = append(resume, book)
		}
	}

	// A run cut short by a deploy or a crash picks itself back up: the flag is
	// persisted, so even a restart during the wait still resumes.
	pending, err := w.St.Books.Find(ctx, bson.M{"deleted": bson.M{"$ne": true}, "resumeAudio": true}, nil)
	if err == nil {
		seen := map[string]bool{}
		for _, b := range resume {
			seen[b.ID.Hex()] = true
		}
		for _, b := range pending {
			if !seen[b.ID.Hex()] {
				resume = append(resume, b)
			}
		}
	}
	for _, book := range resume {
		go w.resumeAudioRun(context.WithoutCancel(ctx), book.ID.Hex(), book.Voices)
	}
	return nil
}

// resumeAudioRun waits for the TTS fabric to come back — after a deploy the
// workers re-register a little after the backend does — then restarts the
// interrupted render. Gives up quietly if the user stopped the book meanwhile
// or no worker shows up.
func (w *Worker) resumeAudioRun(ctx context.Context, bookID string, voices []string) {
	models := map[string]bool{}
	for _, v := range voices {
		m, _ := tts.ParseVoice(v)
		models[m.ID] = true
	}
	ready := func() bool {
		for id := range models {
			if !w.Q.Registry.HasModelWorker(id) {
				return false
			}
		}
		return len(models) > 0
	}

	deadline := time.Now().Add(resumeWaitLimit)
	for !ready() {
		if time.Now().After(deadline) {
			log.Printf("resumeAudioRun %s: no TTS worker for its voices; leaving it stopped", bookID)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}

	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil || !book.ResumeAudio {
		return
	}
	unlock := w.LockBook(bookID)
	r := &run{w: w, book: book}
	err = r.withSave(ctx, func() { book.ResumeAudio = false })
	unlock()
	if err != nil {
		log.Printf("resumeAudioRun %s: clearing flag failed: %v", bookID, err)
		return
	}
	log.Printf("Resuming interrupted audio generation for %q", bookID)
	if err := w.GenerateBookAudio(ctx, bookID); err != nil {
		log.Printf("resumeAudioRun %s failed: %v", bookID, err)
	}
}
