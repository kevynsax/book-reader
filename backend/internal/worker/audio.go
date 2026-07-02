package worker

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/kevynsax/book-reader/backend/internal/config"
	"github.com/kevynsax/book-reader/backend/internal/lib/pool"
	"github.com/kevynsax/book-reader/backend/internal/model"
	"github.com/kevynsax/book-reader/backend/internal/queue"
	"github.com/kevynsax/book-reader/backend/internal/svc/normalizer"
	"github.com/kevynsax/book-reader/backend/internal/svc/tts"
)

// How many times a single reviewed sentence may be SLM-split before its best
// attempt is kept as-is. Each split halves the text, so a few passes always
// converge.
const sentenceSplitMaxDepth = 4

// Cap on how many times one (voice, chapter) may re-render within a single
// run, so a pathological split/verify cycle can't loop forever.
const maxChapterRenders = 8

// splitUnitForTts breaks one reviewed sentence into TTS-ready pieces. A
// sentence whose spoken form fits under TtsMaxSentenceChars is kept whole; a
// longer one is divided by the SLM (an slm-role task) into as many natural
// sub-sentences as needed, each re-checked (speech normalization can
// re-inflate length). `text` is what gets read; `display` keeps the clean
// original; `original` tracks the pre-split source.
func splitUnitForTts(ctx context.Context, q *queue.Client, display, language string, depth int, original *string) []model.Sentence {
	clean := strings.TrimSpace(display)
	if clean == "" {
		return nil
	}
	norm := strings.TrimSpace(normalizer.NormalizeForSpeech(ctx, clean, language))
	if norm == "" {
		return nil
	}
	if len(utf16len(norm)) <= config.TtsMaxSentenceChars || depth >= sentenceSplitMaxDepth {
		d := clean
		return []model.Sentence{{Text: norm, Display: &d, Original: original}}
	}
	parts := tts.SlmSplitToMax(ctx, q, clean, config.TtsMaxSentenceChars)
	if parts == nil {
		d := clean
		return []model.Sentence{{Text: norm, Display: &d, Original: original}}
	}
	src := original
	if src == nil {
		c := clean
		src = &c
	}
	var out []model.Sentence
	for _, part := range parts {
		out = append(out, splitUnitForTts(ctx, q, part, language, depth+1, src)...)
	}
	return out
}

func utf16len(s string) []uint16 {
	units := make([]uint16, 0, len(s))
	for _, r := range s {
		if r > 0xFFFF {
			units = append(units, 0, 0)
		} else {
			units = append(units, uint16(r))
		}
	}
	return units
}

// buildSentences builds the editable, speech-ready sentence list for a
// chapter (once). Returns false if there's no readable text yet. Emits
// per-unit progress (transient — no DB write) on the splitProgress channel.
func (w *Worker) buildSentences(ctx context.Context, r *run, idx int) (bool, error) {
	book := r.book
	chapter := &book.Chapters[idx]
	if len(chapter.Sentences) > 0 {
		return true, nil
	}

	pageTexts := extractChapterPageTexts(book.Chapters, idx, book.OcrPages, book.LastPage)
	units := assembleSentences(pageTexts)
	if len(units) == 0 {
		return false, nil
	}

	language := chapterSpeechLanguage(book, idx)
	splitMsg := fmt.Sprintf("Splitting sentences in %q…", chapter.Title)
	w.emit(book, map[string]any{"splitProgress": progressPayload{Current: 0, Total: len(units), Message: splitMsg}})
	var sentences []model.Sentence
	for i, unit := range units {
		pieces := splitUnitForTts(ctx, w.Q, unit, language, 0, nil)
		// Trace lineage: reviewed line i+1 is "N"; pieces the SLM cut from it
		// up front are "N.1", "N.2", … marked pre-audio-generation.
		base := fmt.Sprint(i + 1)
		for j := range pieces {
			trace := base
			if len(pieces) > 1 {
				trace = fmt.Sprintf("%s.%d", base, j+1)
				when := model.SplitPreGeneration
				pieces[j].SplitCreatedWhen = &when
			}
			pieces[j].TraceOrder = &trace
		}
		sentences = append(sentences, pieces...)
		w.emit(book, map[string]any{"splitProgress": progressPayload{Current: i + 1, Total: len(units), Message: splitMsg}})
	}
	if len(sentences) == 0 {
		return false, nil
	}
	// A cancelled context (pre-splitter unwinding) degrades SLM splits into
	// keep-whole passthroughs — never persist that as a finished split.
	if ctx.Err() != nil {
		return false, ctx.Err()
	}

	if err := r.withSave(ctx, func() {
		for order := range sentences {
			sentences[order].ID = bson.NewObjectID()
			sentences[order].Order = order
		}
		chapter.Sentences = sentences
	}); err != nil {
		return false, err
	}
	return true, nil
}

// ensureSegments makes a track's segments run 1:1 with the chapter's
// sentences, preserving any already-rendered segment audio (by sentenceId).
func ensureSegments(track *model.VoiceTrack, chapter *model.Chapter) {
	byID := map[string]model.Segment{}
	for _, s := range track.Segments {
		byID[s.SentenceID.Hex()] = s
	}
	ordered := append([]model.Sentence(nil), chapter.Sentences...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })
	next := make([]model.Segment, len(ordered))
	for i, sen := range ordered {
		if ex, ok := byID[sen.ID.Hex()]; ok {
			next[i] = model.Segment{
				SentenceID: sen.ID, AudioPath: ex.AudioPath, DurationSecs: ex.DurationSecs,
				AudioStatus: ex.AudioStatus, AudioError: ex.AudioError,
				WhisperResults: ex.WhisperResults,
			}
		} else {
			next[i] = model.Segment{SentenceID: sen.ID, AudioStatus: model.AudioPending}
		}
	}
	track.Segments = next
}

// orderedSegmentInputs is the ordered {audioPath, durationSecs, text,
// display} list for assembly, by sentence order.
func orderedSegmentInputs(chapter *model.Chapter, track *model.VoiceTrack) []tts.SegmentInput {
	byID := map[string]*model.Segment{}
	for i := range track.Segments {
		byID[track.Segments[i].SentenceID.Hex()] = &track.Segments[i]
	}
	ordered := append([]model.Sentence(nil), chapter.Sentences...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })
	out := make([]tts.SegmentInput, len(ordered))
	for i, sen := range ordered {
		text := strings.TrimSpace(sen.Text)
		display := text
		if sen.Display != nil && strings.TrimSpace(*sen.Display) != "" {
			display = strings.TrimSpace(*sen.Display)
		}
		in := tts.SegmentInput{Text: text, Display: display}
		if seg := byID[sen.ID.Hex()]; seg != nil {
			if seg.AudioPath != nil {
				in.AudioPath = *seg.AudioPath
			}
			if seg.DurationSecs != nil {
				in.DurationSecs = *seg.DurationSecs
			}
		}
		out[i] = in
	}
	return out
}

// segmentFilePresent: whether a segment's rendered mp3 is still present and
// non-empty on disk, so resuming only re-synthesizes what actually went
// missing.
func segmentFilePresent(p *string) bool {
	if p == nil {
		return false
	}
	stat, err := os.Stat(*p)
	return err == nil && stat.Size() > 0
}

// finalizeTrack concatenates a track's complete segments into the chapter mp3
// + timeline, or reflects a segment error onto the track. Emits the result.
func (w *Worker) finalizeTrack(ctx context.Context, r *run, idx int, voice, audioDir string, preservePlayable bool) error {
	book := r.book

	var inputs []tts.SegmentInput
	allComplete := false
	r.locked(func() {
		chapter := &book.Chapters[idx]
		track := book.TrackForVoice(chapter, voice)
		if track == nil {
			return
		}
		allComplete = len(track.Segments) > 0
		for _, s := range track.Segments {
			if s.AudioStatus != model.AudioComplete {
				allComplete = false
				break
			}
		}
		if allComplete {
			inputs = orderedSegmentInputs(chapter, track)
		}
	})

	chapter := &book.Chapters[idx]
	track := book.TrackForVoice(chapter, voice)
	if track == nil {
		return nil
	}

	var assembledPath string
	var durationSecs float64
	var assembleErr error
	if allComplete {
		assembledPath = ChapterAudioPath(audioDir, idx, voice)
		durationSecs, assembleErr = tts.AssembleChapter(inputs, assembledPath)
	}

	if err := r.withSave(ctx, func() {
		switch {
		case allComplete && assembleErr == nil:
			rounded := float64(int(durationSecs + 0.5))
			track.AudioPath = &assembledPath
			track.AudioDurationSecs = &rounded
			track.AudioStatus = model.AudioComplete
			track.AudioError = nil
		case allComplete:
			message := "Assembly failed: " + assembleErr.Error()
			log.Printf("assembleChapter %s ch%d (%s): %v", book.ID.Hex(), idx+1, voice, assembleErr)
			track.AudioStatus = model.AudioError
			track.AudioError = &message
		case preservePlayable && track.AudioPath != nil:
			// A single-sentence re-render failed but the previously assembled
			// chapter audio is still valid — keep it playable.
			track.AudioStatus = model.AudioComplete
		default:
			track.AudioStatus = model.DeriveTrackStatus(track.Segments)
			track.AudioError = nil
			for _, s := range track.Segments {
				if s.AudioStatus == model.AudioError {
					track.AudioError = s.AudioError
					break
				}
			}
		}
	}); err != nil {
		return err
	}

	w.emit(book, map[string]any{"chapterUpdate": chapterUpdate{
		Idx: idx, Voice: voice,
		AudioStatus: track.AudioStatus, AudioPath: track.AudioPath,
		AudioDurationSecs: track.AudioDurationSecs, AudioError: track.AudioError,
	}})
	return nil
}

// segmentTask is one sentence to synthesize: indices into the shared Book
// (stable until the pool drains) plus the text/path/language to render it.
type segmentTask struct {
	idx      int
	voice    string
	segIdx   int
	senIdx   int
	text     string
	segPath  string
	language string
}

// pendingSplit is a sentence the primary voice broke into smaller pieces
// during verification. The first piece reuses the original sentence; `extra`
// are the additional pieces to splice in after it once the chapter's render
// pool has drained.
type pendingSplit struct {
	sentenceID string
	extra      []tts.RenderedPiece
	original   string
	// Trace lineage: the sentence's pre-split hierarchical order ("423" or
	// "423.1") and id, so the spliced pieces become "423.1", "423.2" (or
	// "423.1.1", "423.1.2") with SplitOf pointing at the parent.
	parentTrace string
	parentID    bson.ObjectID
}

// renderSegment synthesizes one sentence through the task fabric (whichever
// healthy tts worker claims it), then persists + emits the segment's outcome.
func (w *Worker) renderSegment(ctx context.Context, r *run, task segmentTask, splits *[]pendingSplit) error {
	book := r.book
	if w.stopRequested(book.ID.Hex()) {
		return ErrStopped
	}

	var display string
	r.locked(func() {
		chapter := &book.Chapters[task.idx]
		seg := &book.Chapters[task.idx].Tracks[trackIndex(chapter, task.voice)].Segments[task.segIdx]
		seg.AudioStatus = model.AudioGenerating
		seg.AudioError = nil
		sen := chapter.Sentences[task.senIdx]
		display = task.text
		if sen.Display != nil && strings.TrimSpace(*sen.Display) != "" {
			display = strings.TrimSpace(*sen.Display)
		}
	})

	pieces, err := tts.RenderSegmentPieces(ctx, w.Q, display, task.text, task.voice, task.language)

	var writeErr error
	if err == nil {
		if writeErr = os.MkdirAll(filepath.Dir(task.segPath), 0o755); writeErr == nil {
			writeErr = os.WriteFile(task.segPath, pieces[0].Buffer, 0o644)
		}
	}

	r.locked(func() {
		chapter := &book.Chapters[task.idx]
		seg := &book.Chapters[task.idx].Tracks[trackIndex(chapter, task.voice)].Segments[task.segIdx]
		if err == nil && writeErr == nil {
			segPath := task.segPath
			duration := pieces[0].DurationSecs
			seg.AudioPath = &segPath
			seg.DurationSecs = &duration
			seg.WhisperResults = pieces[0].Transcripts
			if len(pieces) > 1 {
				// First piece reuses this sentence/segment; the rest get
				// spliced in later.
				sen := &chapter.Sentences[task.senIdx]
				original := display
				if sen.Original != nil && strings.TrimSpace(*sen.Original) != "" {
					original = strings.TrimSpace(*sen.Original)
				}
				parentTrace := fmt.Sprint(sen.Order + 1)
				if sen.TraceOrder != nil {
					parentTrace = *sen.TraceOrder
				}
				parentID := sen.ID
				d0 := pieces[0].Display
				when := model.SplitDuringGeneration
				trace0 := parentTrace + ".1"
				sen.Text = pieces[0].Text
				sen.Display = &d0
				sen.Original = &original
				sen.TraceOrder = &trace0
				sen.SplitCreatedWhen = &when
				*splits = append(*splits, pendingSplit{
					sentenceID: sen.ID.Hex(), extra: pieces[1:], original: original,
					parentTrace: parentTrace, parentID: parentID,
				})
			}
			seg.AudioStatus = model.AudioComplete
			seg.AudioError = nil
		} else {
			renderErr := err
			if renderErr == nil {
				renderErr = writeErr
			}
			message := renderErr.Error()
			log.Printf("renderSegment %s ch%d (%s): %v", book.ID.Hex(), task.idx+1, task.voice, renderErr)
			seg.AudioStatus = model.AudioError
			seg.AudioError = &message
		}
	})
	if err := r.withSave(ctx, nil); err != nil {
		return err
	}

	chapter := &book.Chapters[task.idx]
	seg := chapter.Tracks[trackIndex(chapter, task.voice)].Segments[task.segIdx]
	w.emit(book, map[string]any{"segmentUpdate": segmentUpdate{
		ChapterIdx: task.idx, Voice: task.voice, SentenceID: seg.SentenceID.Hex(),
		AudioStatus: seg.AudioStatus, AudioError: seg.AudioError,
	}})
	return nil
}

func trackIndex(chapter *model.Chapter, voice string) int {
	for i := range chapter.Tracks {
		if chapter.Tracks[i].Voice == voice {
			return i
		}
	}
	return -1
}

// applyChapterSplits splices the primary voice's verification splits into the
// chapter's sentence list once its render pool has drained. Every voice's
// segments re-reconcile to the new sentence set; the other voices' tracks go
// stale so the generation loop re-renders just the new pieces.
func (w *Worker) applyChapterSplits(ctx context.Context, r *run, idx int, voice, audioDir string, splits []pendingSplit) error {
	if len(splits) == 0 {
		return nil
	}
	book := r.book
	chapter := &book.Chapters[idx]
	splitByID := map[string]*pendingSplit{}
	for i := range splits {
		splitByID[splits[i].sentenceID] = &splits[i]
	}

	type newAudio struct {
		id    string
		piece tts.RenderedPiece
	}
	var newAudioByNewID []newAudio

	err := r.withSave(ctx, func() {
		ordered := append([]model.Sentence(nil), chapter.Sentences...)
		sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })
		var rebuilt []model.Sentence
		for _, s := range ordered {
			display := s.Text
			if s.Display != nil {
				display = *s.Display
			}
			d := display
			rebuilt = append(rebuilt, model.Sentence{
				ID: s.ID, Text: s.Text, Display: &d, Original: s.Original,
				TraceOrder: s.TraceOrder, SplitOf: s.SplitOf, SplitCreatedWhen: s.SplitCreatedWhen,
			})
			if split := splitByID[s.ID.Hex()]; split != nil {
				for pi, piece := range split.extra {
					id := bson.NewObjectID()
					pd := piece.Display
					po := split.original
					// Piece 1 is the parent record itself (already retagged
					// ".1" in renderSegment); the extras continue ".2", ".3"…
					trace := fmt.Sprintf("%s.%d", split.parentTrace, pi+2)
					when := model.SplitDuringGeneration
					parentID := split.parentID
					rebuilt = append(rebuilt, model.Sentence{
						ID: id, Text: piece.Text, Display: &pd, Original: &po,
						TraceOrder: &trace, SplitOf: &parentID, SplitCreatedWhen: &when,
					})
					newAudioByNewID = append(newAudioByNewID, newAudio{id: id.Hex(), piece: piece})
				}
			}
		}
		for order := range rebuilt {
			rebuilt[order].Order = order
		}
		chapter.Sentences = rebuilt
		for ti := range chapter.Tracks {
			ensureSegments(&chapter.Tracks[ti], chapter)
		}

		// Keep the split consistent across voices: every other voice must
		// re-render this chapter to match the new sentence set. Marking the
		// track stale makes the generation loop pick it up even if it had
		// already finished in a prior run. The split PARENT's segment also
		// goes back to pending for those voices — its audio still speaks the
		// full pre-split text, which would duplicate the tail pieces.
		for ti := range chapter.Tracks {
			if chapter.Tracks[ti].Voice == voice {
				continue
			}
			chapter.Tracks[ti].AudioStatus = model.AudioStale
			chapter.Tracks[ti].AudioError = nil
			for si := range chapter.Tracks[ti].Segments {
				seg := &chapter.Tracks[ti].Segments[si]
				if splitByID[seg.SentenceID.Hex()] != nil {
					*seg = model.Segment{SentenceID: seg.SentenceID, AudioStatus: model.AudioPending}
				}
			}
		}

		// Persist the primary voice's already-rendered audio for new pieces.
		track := book.TrackForVoice(chapter, voice)
		orderByID := map[string]int{}
		for _, s := range chapter.Sentences {
			orderByID[s.ID.Hex()] = s.Order
		}
		for _, na := range newAudioByNewID {
			order, ok := orderByID[na.id]
			if track == nil || !ok {
				continue
			}
			segPath := segmentAudioPath(audioDir, idx, voice, order)
			if err := os.MkdirAll(filepath.Dir(segPath), 0o755); err != nil {
				continue
			}
			if err := os.WriteFile(segPath, na.piece.Buffer, 0o644); err != nil {
				continue
			}
			for si := range track.Segments {
				if track.Segments[si].SentenceID.Hex() == na.id {
					duration := na.piece.DurationSecs
					track.Segments[si].AudioPath = &segPath
					track.Segments[si].DurationSecs = &duration
					track.Segments[si].AudioStatus = model.AudioComplete
					track.Segments[si].AudioError = nil
					track.Segments[si].WhisperResults = na.piece.Transcripts
				}
			}
		}
	})
	if err != nil {
		return err
	}
	w.emit(book, map[string]any{"chapters": model.SerializeChaptersForClient(book.Chapters)})
	return nil
}

type renderProgress struct {
	done  int
	total int
}

// prepareChapterTasks builds a chapter's sentences/segments once, marks the
// track generating, and returns the not-yet-complete segments as tasks.
// Resumable — already complete segments (whose audio is still on disk) are
// skipped.
func (w *Worker) prepareChapterTasks(ctx context.Context, r *run, voice string, idx int, audioDir string, progress *renderProgress) ([]segmentTask, error) {
	book := r.book
	chapter := &book.Chapters[idx]
	track := book.TrackForVoice(chapter, voice)
	if track == nil || track.AudioStatus == model.AudioComplete {
		return nil, nil
	}

	ok, err := w.ensureSentences(ctx, r, idx)
	if err != nil {
		return nil, err
	}
	if !ok {
		audioError := "No readable text for this chapter (run OCR first?)"
		log.Printf("prepareChapterTasks %s ch%d (%s): %s", book.ID.Hex(), idx+1, voice, audioError)
		if err := r.withSave(ctx, func() {
			track.AudioStatus = model.AudioError
			track.AudioError = &audioError
			progress.done++
		}); err != nil {
			return nil, err
		}
		w.emit(book, map[string]any{"chapterUpdate": chapterUpdate{Idx: idx, Voice: voice, AudioStatus: model.AudioError, AudioError: &audioError}})
		return nil, nil
	}

	if err := r.withSave(ctx, func() {
		ensureSegments(track, chapter)
		track.AudioStatus = model.AudioGenerating
		track.AudioError = nil
		progress.done++
	}); err != nil {
		return nil, err
	}
	w.emit(book, map[string]any{"chapterUpdate": chapterUpdate{Idx: idx, Voice: voice, AudioStatus: model.AudioGenerating}})

	language := chapterSpeechLanguage(book, idx)
	senIdxByID := map[string]int{}
	for i, s := range chapter.Sentences {
		senIdxByID[s.ID.Hex()] = i
	}

	var tasks []segmentTask
	reconciled := false
	for si := range track.Segments {
		seg := &track.Segments[si]
		senIdx, found := senIdxByID[seg.SentenceID.Hex()]
		if !found {
			continue
		}
		// A segment counts as done only if its audio is still on disk.
		if seg.AudioStatus == model.AudioComplete {
			if segmentFilePresent(seg.AudioPath) {
				continue
			}
			seg.AudioStatus = model.AudioPending
			seg.AudioError = nil
			reconciled = true
		}
		sen := chapter.Sentences[senIdx]
		tasks = append(tasks, segmentTask{
			idx: idx, voice: voice, segIdx: si, senIdx: senIdx,
			text:     strings.TrimSpace(sen.Text),
			segPath:  segmentAudioPath(audioDir, idx, voice, sen.Order),
			language: language,
		})
	}
	if reconciled {
		if err := r.withSave(ctx, nil); err != nil {
			return nil, err
		}
	}
	return tasks, nil
}

// renderChapter renders one chapter for one voice, balancing its sentences
// across all ready servers with at most TtsConcurrency in flight, then
// assembles. Returns true if the primary voice restructured the chapter's
// sentences.
func (w *Worker) renderChapter(ctx context.Context, r *run, voice string, idx int, audioDir string, progress *renderProgress, chLock *sync.RWMutex) (bool, error) {
	book := r.book
	chapter := &book.Chapters[idx]
	track := book.TrackForVoice(chapter, voice)
	if track == nil || track.AudioStatus == model.AudioComplete {
		return false, nil
	}

	// Fail fast when no live tts worker has a healthy server — the queue
	// would otherwise hold every segment task until timeout. Model loading
	// itself is each worker's own job (hot-swap on the first task).
	ttsModel, _ := tts.ParseVoice(voice)
	if !w.Q.Registry.HasModelWorker(ttsModel.ID) {
		audioError := fmt.Sprintf("No TTS server is online for model %q — start the server and try again.", ttsModel.ID)
		log.Printf("renderChapter %s ch%d (%s): %s", book.ID.Hex(), idx+1, voice, audioError)
		if err := r.withSave(ctx, func() {
			track.AudioStatus = model.AudioError
			track.AudioError = &audioError
			progress.done++
		}); err != nil {
			return false, err
		}
		w.emit(book, map[string]any{"chapterUpdate": chapterUpdate{Idx: idx, Voice: voice, AudioStatus: model.AudioError, AudioError: &audioError}})
		return false, nil
	}

	// Concurrent lanes may render the SAME chapter (different voices) — the
	// read lock allows that; only sentence restructuring (applyChapterSplits)
	// takes the write lock, so no lane ever sees the sentence list change
	// under its captured task indexes.
	chLock.RLock()
	rUnlocked := false
	rUnlock := func() {
		if !rUnlocked {
			rUnlocked = true
			chLock.RUnlock()
		}
	}
	defer rUnlock()

	var splits []pendingSplit
	tasks, err := w.prepareChapterTasks(ctx, r, voice, idx, audioDir, progress)
	if err != nil {
		return false, err
	}

	// Per-chapter progress: percent reflects this chapter's own segments
	// (matching the "Generating …" label), counting resumed ones. Transient —
	// mutated + emitted without a save. voiceProgress carries the same
	// numbers keyed by voice, so the UI can show one live bar per lane when
	// several voices render concurrently.
	title := chapter.Title
	emitChapterProgress := func() {
		var done, total int
		r.locked(func() {
			for _, s := range track.Segments {
				if s.AudioStatus == model.AudioComplete {
					done++
				}
			}
			total = len(track.Segments)
			book.Progress = model.Progress{Current: done, Total: total, Message: fmt.Sprintf("Generating %q…", title)}
		})
		w.emit(book, map[string]any{
			"progress": book.Progress,
			"voiceProgress": map[string]any{
				"voice": voice, "chapterIdx": idx,
				"current": done, "total": total,
				"message": fmt.Sprintf("Generating %q…", title),
			},
		})
	}
	emitChapterProgress()

	err = pool.Run(tasks, config.TtsConcurrency, func(task segmentTask, _ int) error {
		if err := w.renderSegment(ctx, r, task, &splits); err != nil {
			return err
		}
		emitChapterProgress()
		return nil
	})
	if err != nil {
		return false, err
	}

	rUnlock()
	if len(splits) > 0 {
		// Exclusive: waits for other lanes' in-flight renders of this chapter
		// to drain, then restructures. Their tracks get re-staled and the
		// catch-up promotion re-renders just the new pieces.
		chLock.Lock()
		err = w.applyChapterSplits(ctx, r, idx, voice, audioDir, splits)
		chLock.Unlock()
		if err != nil {
			return false, err
		}
	}
	if err := w.finalizeTrack(ctx, r, idx, voice, audioDir, false); err != nil {
		return false, err
	}
	return len(splits) > 0, nil
}

type job struct {
	voice string
	idx   int
}

// renderWork renders a worklist of (voice, chapter) jobs to completion,
// keeping all voices' splits consistent: whenever a chapter's render
// restructures its sentences, every other voice's same chapter is re-queued.
// Converges because each split strictly shrinks sentences.
//
// Jobs run in one LANE PER TTS MODEL, and lanes run concurrently: with
// capability routing each model's tasks flow to its own servers, so an
// openaudio voice on the MacBook and an orpheus voice on the GPU server
// render at the same time instead of the second model's servers idling.
// Within a lane jobs stay voice-major (models hot-swap at most per voice).
// A per-chapter lock keeps two lanes off the same chapter — a concurrent
// split would restructure sentences under the other lane's feet.
func (w *Worker) renderWork(ctx context.Context, r *run, audioDir string, progress *renderProgress, seed []job) error {
	book := r.book
	key := func(j job) string { return j.voice + "|" + fmt.Sprint(j.idx) }
	laneOf := func(voice string) string {
		m, _ := tts.ParseVoice(voice)
		return m.ID
	}

	var mu sync.Mutex
	cond := sync.NewCond(&mu)
	queues := map[string][]job{}   // lane -> pending jobs
	queued := map[string]bool{}    // job key -> waiting in some lane
	renders := map[string]int{}    // job key -> attempts (re-render cap)
	chapterLocks := map[int]*sync.RWMutex{}
	for idx := range book.Chapters {
		chapterLocks[idx] = &sync.RWMutex{}
	}
	var laneOrder []string
	for _, j := range seed {
		lane := laneOf(j.voice)
		if _, ok := queues[lane]; !ok {
			laneOrder = append(laneOrder, lane)
		}
		queues[lane] = append(queues[lane], j)
		queued[key(j)] = true
	}

	idle := map[string]bool{}
	catchups := 0
	var firstErr error
	done := func() bool { // mu held
		if firstErr != nil {
			return true
		}
		if catchups > 0 {
			return false
		}
		for _, lane := range laneOrder {
			if len(queues[lane]) > 0 || !idle[lane] {
				return false
			}
		}
		return true
	}
	// push queues j into its lane; front promotes past everything pending.
	push := func(j job, front bool) { // mu held
		lane := laneOf(j.voice)
		k := key(j)
		if queued[k] && !front {
			return
		}
		q := queues[lane]
		if queued[k] {
			kept := q[:0]
			for _, e := range q {
				if key(e) != k {
					kept = append(kept, e)
				}
			}
			q = kept
		}
		if front {
			q = append([]job{j}, q...)
		} else {
			q = append(q, j)
		}
		queues[lane] = q
		queued[k] = true
	}

	hasRenderedWork := func(j job) bool {
		var has bool
		r.locked(func() {
			t := book.TrackForVoice(&book.Chapters[j.idx], j.voice)
			if t == nil {
				return
			}
			for _, s := range t.Segments {
				if s.AudioStatus == model.AudioComplete {
					has = true
					return
				}
			}
		})
		return has
	}

	// A split invalidates every other voice's copy of its chapter. A voice
	// that had already rendered it re-renders its few new pieces IMMEDIATELY
	// in its own goroutine — not queued behind whatever chapter its lane is
	// currently rendering — so a finished chapter goes back to playable within
	// moments of being staled. A voice that hasn't reached the chapter yet
	// keeps its voice-major turn (no early model hot-swap). A catch-up already
	// in flight for the same (voice, chapter) is flagged to run once more, so
	// a second split landing mid-render isn't lost.
	var catchupWG sync.WaitGroup
	catchupState := map[string]int{} // 1 = running, 2 = running + rerun requested
	var afterRender func(j job, didSplit bool)
	var runCatchup func(j job)
	runCatchup = func(j job) { // mu held
		k := key(j)
		if catchupState[k] > 0 {
			catchupState[k] = 2
			return
		}
		renders[k]++
		if renders[k] > maxChapterRenders {
			log.Printf("renderWork %s: %s hit the re-render cap; leaving as-is", book.ID.Hex(), k)
			return
		}
		catchupState[k] = 1
		catchups++
		catchupWG.Add(1)
		go func() {
			defer catchupWG.Done()
			var didSplit bool
			var err error
			if w.stopRequested(book.ID.Hex()) {
				err = ErrStopped
			} else {
				didSplit, err = w.renderChapter(ctx, r, j.voice, j.idx, audioDir, progress, chapterLocks[j.idx])
			}

			mu.Lock()
			catchups--
			rerun := catchupState[k] == 2
			delete(catchupState, k)
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
			} else {
				afterRender(j, didSplit)
				if rerun && firstErr == nil {
					runCatchup(j)
				}
			}
			cond.Broadcast()
			mu.Unlock()
		}()
	}
	afterRender = func(j job, didSplit bool) { // mu held
		if !didSplit {
			return
		}
		for _, other := range book.Voices {
			if other == j.voice {
				continue
			}
			oj := job{voice: other, idx: j.idx}
			if hasRenderedWork(oj) {
				runCatchup(oj)
			} else {
				push(oj, false)
			}
		}
	}

	var wg sync.WaitGroup
	for _, lane := range laneOrder {
		wg.Add(1)
		go func(lane string) {
			defer wg.Done()
			mu.Lock()
			defer mu.Unlock()
			for {
				if firstErr != nil {
					return
				}
				if len(queues[lane]) == 0 {
					idle[lane] = true
					if done() {
						cond.Broadcast()
						return
					}
					cond.Wait()
					continue
				}
				idle[lane] = false
				j := queues[lane][0]
				queues[lane] = queues[lane][1:]
				k := key(j)
				delete(queued, k)
				renders[k]++
				if renders[k] > maxChapterRenders {
					log.Printf("renderWork %s: %s hit the re-render cap; leaving as-is", book.ID.Hex(), k)
					continue
				}
				mu.Unlock()

				var didSplit bool
				var err error
				if w.stopRequested(book.ID.Hex()) {
					err = ErrStopped
				} else {
					didSplit, err = w.renderChapter(ctx, r, j.voice, j.idx, audioDir, progress, chapterLocks[j.idx])
				}

				mu.Lock()
				if err != nil {
					if firstErr == nil {
						firstErr = err
					}
					cond.Broadcast()
					return
				}
				afterRender(j, didSplit)
				if didSplit {
					cond.Broadcast()
				}
			}
		}(lane)
	}
	wg.Wait()
	catchupWG.Wait()
	if firstErr != nil {
		return firstErr
	}
	return nil
}

// pendingJobs seeds jobs for the voices' chapters that still need rendering,
// voice-major so each server loads a voice's model once and renders all its
// chapters before moving on.
func pendingJobs(book *model.Book, voices []string) []job {
	var jobs []job
	for _, voice := range voices {
		for idx := range book.Chapters {
			t := book.TrackForVoice(&book.Chapters[idx], voice)
			if t != nil && t.AudioStatus != model.AudioComplete {
				jobs = append(jobs, job{voice: voice, idx: idx})
			}
		}
	}
	return jobs
}

func (w *Worker) generateForVoices(ctx context.Context, book *model.Book, voices []string, manageBookStatus bool) error {
	r := &run{w: w, book: book}
	audioDir := filepath.Join(book.FolderPath, "audio")
	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		return err
	}

	w.ensureBookLanguage(ctx, r)

	if manageBookStatus {
		if err := r.withSave(ctx, func() { book.Status = model.StatusGeneratingAudio }); err != nil {
			return err
		}
		w.emit(book, map[string]any{"status": model.StatusGeneratingAudio})
	}

	progress := &renderProgress{total: len(voices) * len(book.Chapters)}

	// Split every chapter's sentences in the background (SLM work) while the
	// TTS fleet renders — chapter boundaries stop costing a split pause.
	splitCtx, cancelSplit := context.WithCancel(ctx)
	splitterDone := make(chan struct{})
	go func() {
		defer close(splitterDone)
		w.preSplitChapters(splitCtx, r)
	}()

	renderErr := w.renderWork(ctx, r, audioDir, progress, pendingJobs(book, voices))
	cancelSplit()
	<-splitterDone

	if renderErr != nil {
		if renderErr == ErrStopped {
			return w.finalizeStop(ctx, r, manageBookStatus, false)
		}
		return renderErr
	}

	var failed []*model.VoiceTrack
	for ci := range book.Chapters {
		for ti := range book.Chapters[ci].Tracks {
			if book.Chapters[ci].Tracks[ti].AudioStatus == model.AudioError {
				failed = append(failed, &book.Chapters[ci].Tracks[ti])
			}
		}
	}

	if manageBookStatus {
		if len(failed) > 0 {
			seen := map[string]bool{}
			var reasons []string
			for _, t := range failed {
				if t.AudioError != nil && !seen[*t.AudioError] {
					seen[*t.AudioError] = true
					reasons = append(reasons, *t.AudioError)
				}
			}
			plural := ""
			if len(failed) > 1 {
				plural = "s"
			}
			message := fmt.Sprintf("%d chapter%s failed to generate", len(failed), plural)
			if len(reasons) > 0 {
				message += ": " + strings.Join(reasons, "; ")
			} else {
				message += "."
			}
			if err := r.withSave(ctx, func() {
				book.Status = model.StatusError
				book.ErrorMessage = &message
			}); err != nil {
				return err
			}
			w.emit(book, map[string]any{
				"status": model.StatusError, "errorMessage": message,
				"chapters": model.SerializeChaptersForClient(book.Chapters),
			})
		} else {
			if err := r.withSave(ctx, func() {
				book.Status = model.StatusComplete
				book.Progress = model.Progress{Current: progress.total, Total: progress.total, Message: "Complete!"}
			}); err != nil {
				return err
			}
			w.emit(book, map[string]any{
				"status": model.StatusComplete, "progress": book.Progress,
				"chapters": model.SerializeChaptersForClient(book.Chapters),
			})
		}
	} else {
		if err := r.withSave(ctx, nil); err != nil {
			return err
		}
		w.emit(book, map[string]any{"chapters": model.SerializeChaptersForClient(book.Chapters)})
	}
	return nil
}

// GenerateBookAudio is a resume — already-complete segments are skipped. If a
// run is already in flight, the call is ignored so a Continue click can't
// spawn a second concurrent render over the same tracks.
func (w *Worker) GenerateBookAudio(ctx context.Context, bookID string) error {
	release, ok := w.TryRun(bookID)
	if !ok {
		log.Printf("generateBookAudio %s: a run is already in flight; ignoring", bookID)
		return nil
	}
	defer release()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}

	if err := w.generateForVoices(ctx, book, book.Voices, true); err != nil {
		message := err.Error()
		r := &run{w: w, book: book}
		_ = r.withSave(ctx, func() {
			book.Status = model.StatusError
			book.ErrorMessage = &message
		})
		w.emit(book, map[string]any{"status": model.StatusError, "errorMessage": message})
	}
	return nil
}

func (w *Worker) GenerateVoiceAudio(ctx context.Context, bookID string, voices []string) error {
	release, ok := w.TryRun(bookID)
	if !ok {
		log.Printf("generateVoiceAudio %s: a run is already in flight; ignoring", bookID)
		return nil
	}
	defer release()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	if err := w.generateForVoices(ctx, book, voices, false); err != nil {
		log.Printf("generateVoiceAudio %s %s failed: %v", bookID, strings.Join(voices, ", "), err)
	}
	return nil
}

// RegenerateChapterAudio does a full chapter rebuild (e.g. after
// OCR/chapter-boundary edits): discard cached sentences + segment audio so
// the latest text is re-read from scratch.
func (w *Worker) RegenerateChapterAudio(ctx context.Context, bookID string, chapterIdx int) error {
	release, ok := w.TryRun(bookID)
	if !ok {
		log.Printf("regenerateChapterAudio %s: a run is already in flight; ignoring", bookID)
		return nil
	}
	defer release()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	if chapterIdx < 0 || chapterIdx >= len(book.Chapters) {
		return nil
	}
	r := &run{w: w, book: book}

	w.ensureBookLanguage(ctx, r)

	audioDir := filepath.Join(book.FolderPath, "audio")
	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		return err
	}

	if err := r.withSave(ctx, func() {
		chapter := &book.Chapters[chapterIdx]
		chapter.Sentences = []model.Sentence{}
		for ti := range chapter.Tracks {
			chapter.Tracks[ti].Segments = []model.Segment{}
			chapter.Tracks[ti].AudioStatus = model.AudioPending
			chapter.Tracks[ti].AudioError = nil
		}
	}); err != nil {
		return err
	}
	for _, voice := range book.Voices {
		os.RemoveAll(SegmentDir(audioDir, chapterIdx, voice))
	}

	progress := &renderProgress{total: len(book.Voices)}
	var seed []job
	for _, j := range pendingJobs(book, book.Voices) {
		if j.idx == chapterIdx {
			seed = append(seed, j)
		}
	}
	if err := w.renderWork(ctx, r, audioDir, progress, seed); err != nil {
		if err == ErrStopped {
			return w.finalizeStop(ctx, r, false, false)
		}
		return err
	}
	return nil
}

// clearTrackAudio discards one voice's cached segments + audio files for a
// chapter so it re-synthesizes from scratch. Keeps shared sentences intact.
func clearTrackAudio(book *model.Book, audioDir string, chapterIdx int, voice string) {
	chapter := &book.Chapters[chapterIdx]
	if track := book.TrackForVoice(chapter, voice); track != nil {
		track.Segments = []model.Segment{}
		track.AudioStatus = model.AudioPending
		track.AudioError = nil
		track.AudioPath = nil
		track.AudioDurationSecs = nil
	}
	os.RemoveAll(SegmentDir(audioDir, chapterIdx, voice))
	os.Remove(ChapterAudioPath(audioDir, chapterIdx, voice))
}

// RegenerateVoiceAudio regenerates one voice across every chapter.
func (w *Worker) RegenerateVoiceAudio(ctx context.Context, bookID, voice string) error {
	release, ok := w.TryRun(bookID)
	if !ok {
		log.Printf("regenerateVoiceAudio %s: a run is already in flight; ignoring", bookID)
		return nil
	}
	defer release()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	if !contains(book.Voices, voice) {
		return nil
	}
	r := &run{w: w, book: book}

	audioDir := filepath.Join(book.FolderPath, "audio")
	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		return err
	}

	if err := r.withSave(ctx, func() {
		for idx := range book.Chapters {
			clearTrackAudio(book, audioDir, idx, voice)
		}
	}); err != nil {
		return err
	}
	w.emit(book, map[string]any{"chapters": model.SerializeChaptersForClient(book.Chapters)})

	if err := w.generateForVoices(ctx, book, []string{voice}, false); err != nil {
		log.Printf("regenerateVoiceAudio %s %s failed: %v", bookID, voice, err)
	}
	return nil
}

// RegenerateChapterVoiceAudio regenerates a single chapter for a single voice.
func (w *Worker) RegenerateChapterVoiceAudio(ctx context.Context, bookID string, chapterIdx int, voice string) error {
	release, ok := w.TryRun(bookID)
	if !ok {
		log.Printf("regenerateChapterVoiceAudio %s: a run is already in flight; ignoring", bookID)
		return nil
	}
	defer release()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	if chapterIdx < 0 || chapterIdx >= len(book.Chapters) || !contains(book.Voices, voice) {
		return nil
	}
	r := &run{w: w, book: book}

	w.ensureBookLanguage(ctx, r)

	audioDir := filepath.Join(book.FolderPath, "audio")
	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		return err
	}

	if err := r.withSave(ctx, func() { clearTrackAudio(book, audioDir, chapterIdx, voice) }); err != nil {
		return err
	}
	w.emit(book, map[string]any{"chapterUpdate": chapterUpdate{Idx: chapterIdx, Voice: voice, AudioStatus: model.AudioPending}})

	progress := &renderProgress{total: 1}
	if err := w.renderWork(ctx, r, audioDir, progress, []job{{voice: voice, idx: chapterIdx}}); err != nil {
		if err == ErrStopped {
			return w.finalizeStop(ctx, r, false, false)
		}
		return err
	}
	return nil
}

// ContinueChapterVoiceAudio continues a single chapter/voice after an error
// or interruption: keep every segment already on disk and synthesize only the
// missing ones, then assemble.
func (w *Worker) ContinueChapterVoiceAudio(ctx context.Context, bookID string, chapterIdx int, voice string) error {
	release, ok := w.TryRun(bookID)
	if !ok {
		log.Printf("continueChapterVoiceAudio %s: a run is already in flight; ignoring", bookID)
		return nil
	}
	defer release()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	if chapterIdx < 0 || chapterIdx >= len(book.Chapters) || !contains(book.Voices, voice) {
		return nil
	}
	r := &run{w: w, book: book}

	w.ensureBookLanguage(ctx, r)

	audioDir := filepath.Join(book.FolderPath, "audio")
	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		return err
	}

	track := book.TrackForVoice(&book.Chapters[chapterIdx], voice)
	if track == nil || track.AudioStatus == model.AudioComplete {
		return nil
	}
	if err := r.withSave(ctx, func() { track.AudioError = nil }); err != nil {
		return err
	}

	progress := &renderProgress{total: 1}
	if err := w.renderWork(ctx, r, audioDir, progress, []job{{voice: voice, idx: chapterIdx}}); err != nil {
		if err == ErrStopped {
			return w.finalizeStop(ctx, r, false, false)
		}
		return err
	}
	return nil
}

// ReassembleBookAudio rebuilds chapter mp3s + read-along timelines from
// already-rendered segment audio, without re-synthesizing. Only
// fully-rendered tracks whose segment files are still on disk are
// reassembled.
func (w *Worker) ReassembleBookAudio(ctx context.Context, bookID string) error {
	release, ok := w.TryRun(bookID)
	if !ok {
		log.Printf("reassembleBookAudio %s: a run is already in flight; ignoring", bookID)
		return nil
	}
	defer release()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	r := &run{w: w, book: book}
	audioDir := filepath.Join(book.FolderPath, "audio")
	for idx := range book.Chapters {
		for _, voice := range book.Voices {
			track := book.TrackForVoice(&book.Chapters[idx], voice)
			if track == nil || len(track.Segments) == 0 {
				continue
			}
			ready := true
			for _, s := range track.Segments {
				if s.AudioStatus != model.AudioComplete || !segmentFilePresent(s.AudioPath) {
					ready = false
					break
				}
			}
			if ready {
				if err := w.finalizeTrack(ctx, r, idx, voice, audioDir, false); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}
