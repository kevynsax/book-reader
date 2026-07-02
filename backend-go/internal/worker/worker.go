// Package worker is the port of workers/bookProcessor.ts: the import
// pipeline, audio generation across voices/chapters/segments, and the
// recovery/migration jobs.
package worker

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"sync"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/kevynsax/book-reader/backend-go/internal/model"
	"github.com/kevynsax/book-reader/backend-go/internal/queue"
	"github.com/kevynsax/book-reader/backend-go/internal/store"
	"github.com/kevynsax/book-reader/backend-go/internal/ws"
)

func newObjectID() bson.ObjectID { return bson.NewObjectID() }

type Worker struct {
	St  *store.Store
	Hub ws.Emitter
	// Q is the role-worker task fabric: every AI call (OCR, synthesis,
	// transcription, sentence splitting) is submitted as a task and executed
	// by whichever healthy role worker claims it.
	Q *queue.Client

	// Books with audio generation currently in flight, and those a user asked
	// to stop. Generation is cooperative: the render loop checks the stop flag
	// at chapter and segment boundaries and unwinds via ErrStopped, leaving
	// already-rendered chapters intact while no new work is dispatched.
	mu     sync.Mutex
	active map[string]bool
	stops  map[string]bool
}

func New(st *store.Store, hub ws.Emitter, q *queue.Client) *Worker {
	return &Worker{St: st, Hub: hub, Q: q, active: map[string]bool{}, stops: map[string]bool{}}
}

// run wraps one generation run over a shared *model.Book: the mutex is the
// SaveLock equivalent plus the mutation atomicity Node got from its event
// loop. Rule: hold mu across mutate+Save (withSave); slow work (TTS HTTP,
// ffmpeg) stays outside.
type run struct {
	w    *Worker
	book *model.Book
	mu   sync.Mutex
}

// withSave locks, applies fn's mutations, persists the whole document, and
// unlocks. Emits happen after, outside the lock.
func (r *run) withSave(ctx context.Context, fn func()) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if fn != nil {
		fn()
	}
	return r.w.St.Books.Save(ctx, r.book)
}

// locked runs fn under the run mutex without saving (for reads/mutations
// that Node did between saves).
func (r *run) locked(fn func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	fn()
}

// emit broadcasts a book:update patch; field names/shapes mirror Node's
// io.emit call sites exactly (undefined → omitted via omitempty pointers).
func (w *Worker) emit(book *model.Book, update map[string]any) {
	payload := map[string]any{"bookId": book.ID.Hex(), "updatedAt": book.UpdatedAt}
	for k, v := range update {
		payload[k] = v
	}
	w.Hub.Emit("book:update", payload)
}

var unsafeVoiceChars = regexp.MustCompile(`[^a-zA-Z0-9._-]`)

func safeVoice(voice string) string {
	return unsafeVoiceChars.ReplaceAllString(voice, "_")
}

func ChapterAudioPath(audioDir string, chapterIdx int, voice string) string {
	return filepath.Join(audioDir, fmt.Sprintf("chapter-%03d__%s.mp3", chapterIdx+1, safeVoice(voice)))
}

func SegmentDir(audioDir string, chapterIdx int, voice string) string {
	return filepath.Join(audioDir, fmt.Sprintf("chapter-%03d__%s", chapterIdx+1, safeVoice(voice)))
}

func segmentAudioPath(audioDir string, chapterIdx int, voice string, order int) string {
	return filepath.Join(SegmentDir(audioDir, chapterIdx, voice), fmt.Sprintf("seg-%04d.mp3", order+1))
}

// chapterUpdate / segmentUpdate are the WS patch payload shapes the frontend
// reads; optional fields must be absent (not null) exactly like Node.
type chapterUpdate struct {
	Idx               int               `json:"idx"`
	Voice             string            `json:"voice,omitempty"`
	AudioStatus       model.AudioStatus `json:"audioStatus,omitempty"`
	AudioPath         *string           `json:"audioPath,omitempty"`
	AudioDurationSecs *float64          `json:"audioDurationSecs,omitempty"`
	AudioError        *string           `json:"audioError,omitempty"`
}

type segmentUpdate struct {
	ChapterIdx  int               `json:"chapterIdx"`
	Voice       string            `json:"voice"`
	SentenceID  string            `json:"sentenceId"`
	AudioStatus model.AudioStatus `json:"audioStatus"`
	AudioError  *string           `json:"audioError,omitempty"`
}

type progressPayload struct {
	Current int    `json:"current"`
	Total   int    `json:"total"`
	Message string `json:"message"`
}
