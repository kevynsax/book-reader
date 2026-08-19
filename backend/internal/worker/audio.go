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
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/kevynsax/book-reader/backend/internal/config"
	"github.com/kevynsax/book-reader/backend/internal/lib/pool"
	"github.com/kevynsax/book-reader/backend/internal/lib/sentences"
	"github.com/kevynsax/book-reader/backend/internal/model"
	"github.com/kevynsax/book-reader/backend/internal/queue"
	"github.com/kevynsax/book-reader/backend/internal/svc/normalizer"
	"github.com/kevynsax/book-reader/backend/internal/svc/tts"
)

// How many times a single reviewed sentence may be SLM-split before its best
// attempt is kept as-is. Each split halves the text, so a few passes always
// converge.
const sentenceSplitMaxDepth = 4

// splitUnitForTts breaks one reviewed sentence into TTS-ready pieces. A
// sentence whose spoken form fits under TtsMaxSentenceChars is kept whole; a
// longer one is divided by the SLM (an slm-role task) into as many natural
// sub-sentences as needed, each re-checked (speech normalization can
// re-inflate length). `text` is what gets read; `display` keeps the clean
// original; `original` tracks the pre-split source.
func (w *Worker) splitUnitForTts(ctx context.Context, display, language string, depth int, original *string) []model.Sentence {
	clean := strings.TrimSpace(normalizer.StripFootnoteMarks(display))
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
	parts := w.slmSplitToMaxCached(ctx, clean)
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
		out = append(out, w.splitUnitForTts(ctx, part, language, depth+1, src)...)
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
	// Units fan out across a small pool so every SLM worker gets fed — the
	// shared tasks.slm queue balances the concurrent splits across servers.
	// Results collect per index and flatten in order, so sentence order and
	// trace lineage are identical to the sequential path.
	pieced := make([][]model.Sentence, len(units))
	var splitDone atomic.Int64
	_ = pool.Run(units, config.SentenceSplitConcurrency, func(unit string, i int) error {
		// Quotation runs become their own sentences so a different voice can
		// speak them; the classifier later refines WHO (default: quoteDefault).
		var pieces []model.Sentence
		for _, qr := range sentences.SplitQuoteRuns(unit) {
			ps := w.splitUnitForTts(ctx, qr.Text, language, 0, nil)
			if qr.IsQuote {
				for k := range ps {
					ps[k].Role = model.RoleQuoteDefault
				}
			}
			pieces = append(pieces, ps...)
		}
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
		pieced[i] = pieces
		w.emit(book, map[string]any{"splitProgress": progressPayload{Current: int(splitDone.Add(1)), Total: len(units), Message: splitMsg}})
		return nil
	})
	var built []model.Sentence
	for _, pieces := range pieced {
		built = append(built, pieces...)
	}
	if len(built) == 0 {
		return false, nil
	}
	// The chapter heading is the first short line — the title role drives its
	// alternative voice and the silence/gain treatment during assembly.
	if built[0].Role == model.RoleNone && sentences.IsTitle(built[0].Text, config.TitleMaxWords) {
		built[0].Role = model.RoleTitle
	}
	// A cancelled context (pre-splitter unwinding) degrades SLM splits into
	// keep-whole passthroughs — never persist that as a finished split.
	if ctx.Err() != nil {
		return false, ctx.Err()
	}

	if err := r.withSave(ctx, func() {
		for order := range built {
			built[order].ID = bson.NewObjectID()
			built[order].Order = order
		}
		chapter.Sentences = built
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
				WhisperResults: ex.WhisperResults, NeedsReview: ex.NeedsReview,
				AltAudioPath: ex.AltAudioPath, AltDurationSecs: ex.AltDurationSecs, AltVoice: ex.AltVoice,
			}
		} else {
			next[i] = model.Segment{SentenceID: sen.ID, AudioStatus: model.AudioPending}
		}
	}
	track.Segments = next
}

// chapterHasRoles: whether any sentence carries a role — the switch between
// role-driven voicing and the legacy word-count title heuristic.
func chapterHasRoles(chapter *model.Chapter) bool {
	for _, s := range chapter.Sentences {
		if s.Role != model.RoleNone {
			return true
		}
	}
	return false
}

// segmentIsTitle: role wins when the chapter has roles; the word-count
// heuristic remains the fallback for legacy books without them.
func segmentIsTitle(sen model.Sentence, hasRoles bool) bool {
	if hasRoles {
		return sen.Role == model.RoleTitle
	}
	return sentences.IsTitle(sen.Text, config.TitleMaxWords)
}

// orderedSegmentInputs is the ordered {audioPath, durationSecs, text,
// display} list for assembly, by sentence order.
func orderedSegmentInputs(chapter *model.Chapter, track *model.VoiceTrack) []tts.SegmentInput {
	byID := map[string]*model.Segment{}
	for i := range track.Segments {
		byID[track.Segments[i].SentenceID.Hex()] = &track.Segments[i]
	}
	hasRoles := chapterHasRoles(chapter)
	ordered := append([]model.Sentence(nil), chapter.Sentences...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })
	out := make([]tts.SegmentInput, len(ordered))
	for i, sen := range ordered {
		text := strings.TrimSpace(sen.Text)
		display := text
		if sen.Display != nil && strings.TrimSpace(*sen.Display) != "" {
			display = strings.TrimSpace(*sen.Display)
		}
		in := tts.SegmentInput{
			Text:    text,
			Display: display,
			IsTitle: segmentIsTitle(sen, hasRoles),
			Quote:   sen.Role != model.RoleNone && sen.Role != model.RoleTitle,
		}
		if seg := byID[sen.ID.Hex()]; seg != nil {
			if seg.AudioPath != nil {
				in.AudioPath = *seg.AudioPath
			}
			if seg.DurationSecs != nil {
				in.DurationSecs = *seg.DurationSecs
			}
			if seg.AltAudioPath != nil {
				in.AltAudioPath = *seg.AltAudioPath
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
	variants := map[string]model.TrackVariant{}
	if allComplete {
		message := fmt.Sprintf("Merging %q audio…", chapter.Title)
		w.emit(book, map[string]any{
			"voiceProgress": map[string]any{
				"voice": voice, "chapterIdx": idx,
				"current": len(inputs), "total": len(inputs),
				"message": message,
			},
		})
		assembledPath = ChapterAudioPath(audioDir, idx, voice)
		durationSecs, assembleErr = tts.AssembleChapter(inputs, assembledPath, tts.AssembleVariant{})
		if assembleErr == nil {
			for _, v := range variantsFor(inputs) {
				path := ChapterAudioVariantPath(audioDir, idx, voice, v.Key())
				dur, err := tts.AssembleChapter(inputs, path, v)
				if err != nil {
					// A broken variant never blocks the default mix — the
					// serving route falls back to it for the missing key.
					log.Printf("assembleChapter %s ch%d (%s) variant %q: %v", book.ID.Hex(), idx+1, voice, v.Key(), err)
					continue
				}
				variants[v.Key()] = model.TrackVariant{AudioPath: path, DurationSecs: dur}
			}
		}
	}

	if err := r.withSave(ctx, func() {
		switch {
		case allComplete && assembleErr == nil:
			rounded := float64(int(durationSecs + 0.5))
			track.AudioPath = &assembledPath
			track.AudioDurationSecs = &rounded
			track.AudioStatus = model.AudioComplete
			track.AudioError = nil
			track.Variants = nil
			if len(variants) > 0 {
				track.Variants = variants
			}
		case allComplete:
			message := "Assembly failed: " + assembleErr.Error()
			log.Printf("assembleChapter %s ch%d (%s): %v", book.ID.Hex(), idx+1, voice, assembleErr)
			track.AudioStatus = model.AudioError
			track.AudioError = &message
		case preservePlayable && track.AudioPath != nil:
			// A single-sentence re-render failed but the previously assembled
			// chapter audio is still valid — keep it playable.
			track.AudioStatus = model.AudioComplete
		case len(track.Segments) == 0 && track.AudioStatus == model.AudioError:
			// Preparation already flagged the chapter (e.g. no readable text);
			// deriving from zero segments would erase that error as "pending".
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
		Variants: track.Variants,
	}})
	return nil
}

// variantsFor lists the alternative mixes worth assembling: only variants
// whose toggled roles actually have alt takes in this chapter.
func variantsFor(inputs []tts.SegmentInput) []tts.AssembleVariant {
	altTitle, altQuote := false, false
	for _, in := range inputs {
		if in.AltAudioPath == "" {
			continue
		}
		if in.IsTitle {
			altTitle = true
		}
		if in.Quote {
			altQuote = true
		}
	}
	var out []tts.AssembleVariant
	if altTitle {
		out = append(out, tts.AssembleVariant{AltTitle: true})
	}
	if altQuote {
		out = append(out, tts.AssembleVariant{AltQuote: true})
	}
	if altTitle && altQuote {
		out = append(out, tts.AssembleVariant{AltTitle: true, AltQuote: true})
	}
	return out
}

// segmentTask is one sentence to synthesize: indices into the shared Book
// (stable until the pool drains) plus the text/path/language to render it.
// priority is the chapter's position in the run's global work order, handed
// to the dispatcher so every server serves the earliest chapter it can.
type segmentTask struct {
	idx int
	// voice owns the track the audio lands in; synthVoice is what actually
	// speaks it (they differ when the sentence carries a voice override).
	voice      string
	synthVoice string
	// altSynthVoice, when set, is the role voice for the sentence's alt take
	// (rendered to altPathFor(segPath) alongside the plain one).
	altSynthVoice string
	// Which takes this task still has to render — a resume skips takes whose
	// audio already sits on disk.
	needPlain bool
	needAlt   bool
	segIdx    int
	senIdx    int
	text      string
	segPath   string
	language  string
	priority  int64
}

// altPathFor derives the alt take's file from the plain take's path.
func altPathFor(p string) string {
	return strings.TrimSuffix(p, ".mp3") + ".alt.mp3"
}

// renderSegment synthesizes one sentence on the tts server the dispatcher
// grants, then persists + emits the segment's outcome. stopCtx cancels
// renders parked in the dispatcher when the user stops the run.
func (w *Worker) renderSegment(ctx, stopCtx context.Context, r *run, task segmentTask) error {
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

	synthVoice := task.synthVoice
	if synthVoice == "" {
		synthVoice = task.voice
	}

	renderTake := func(voice, outPath string) (tts.RenderedPiece, error) {
		piece, err := tts.RenderSegment(stopCtx, w.Q, display, task.text, voice, task.language, task.priority)
		if err != nil {
			return piece, err
		}
		if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
			return piece, err
		}
		return piece, os.WriteFile(outPath, piece.Buffer, 0o644)
	}

	var plain, alt tts.RenderedPiece
	var err error
	if task.needPlain {
		plain, err = renderTake(synthVoice, task.segPath)
	}
	if err == nil && task.needAlt && task.altSynthVoice != "" {
		alt, err = renderTake(task.altSynthVoice, altPathFor(task.segPath))
	}

	if err != nil && stopCtx.Err() != nil {
		// The stop cancelled this render mid-flight; put the segment back to
		// pending so a resume simply re-renders it.
		r.locked(func() {
			chapter := &book.Chapters[task.idx]
			seg := &chapter.Tracks[trackIndex(chapter, task.voice)].Segments[task.segIdx]
			seg.AudioStatus = model.AudioPending
			seg.AudioError = nil
		})
		if err := r.withSave(ctx, nil); err != nil {
			return err
		}
		return ErrStopped
	}

	r.locked(func() {
		chapter := &book.Chapters[task.idx]
		seg := &book.Chapters[task.idx].Tracks[trackIndex(chapter, task.voice)].Segments[task.segIdx]
		if err == nil {
			if task.needPlain {
				segPath := task.segPath
				duration := plain.DurationSecs
				seg.AudioPath = &segPath
				seg.DurationSecs = &duration
				seg.WhisperResults = plain.Transcripts
				seg.NeedsReview = plain.Mismatch
			}
			if task.altSynthVoice != "" {
				if task.needAlt {
					altPath := altPathFor(task.segPath)
					altDur := alt.DurationSecs
					seg.AltAudioPath = &altPath
					seg.AltDurationSecs = &altDur
					seg.AltVoice = task.altSynthVoice
					seg.WhisperResults = append(seg.WhisperResults, alt.Transcripts...)
					seg.NeedsReview = seg.NeedsReview || alt.Mismatch
				}
			} else {
				seg.AltAudioPath = nil
				seg.AltDurationSecs = nil
				seg.AltVoice = ""
			}
			seg.AudioStatus = model.AudioComplete
			seg.AudioError = nil
		} else {
			message := err.Error()
			log.Printf("renderSegment %s ch%d (%s): %v", book.ID.Hex(), task.idx+1, task.voice, err)
			seg.AudioStatus = model.AudioError
			seg.AudioError = &message
			seg.NeedsReview = false
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

type renderProgress struct {
	done  int
	total int
}

// prepareChapterTasks builds a chapter's sentences/segments once, marks the
// track generating, and returns the not-yet-complete segments as tasks.
// Resumable — already complete segments (whose audio is still on disk) are
// skipped.
func (w *Worker) prepareChapterTasks(ctx context.Context, r *run, voice string, idx int, priority int64, audioDir string, progress *renderProgress) ([]segmentTask, error) {
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
		sen := chapter.Sentences[senIdx]
		plainVoice := sen.SynthVoiceFor(voice, book.VoiceRoles, false)
		altVoice := sen.SynthVoiceFor(voice, book.VoiceRoles, true)
		if altVoice == plainVoice {
			altVoice = ""
		}
		// A take counts as done only if its audio is still on disk (and, for
		// the alt take, was rendered by the currently configured role voice).
		plainOK := segmentFilePresent(seg.AudioPath)
		altOK := altVoice == "" || (segmentFilePresent(seg.AltAudioPath) && seg.AltVoice == altVoice)
		if seg.AudioStatus == model.AudioComplete {
			if plainOK && altOK {
				continue
			}
			seg.AudioStatus = model.AudioPending
			seg.AudioError = nil
			reconciled = true
		}
		// Keep writing to the file the segment already owns (paths may be
		// id-keyed rather than order-derived after sentence edits).
		segPath := segmentAudioPath(audioDir, idx, voice, sen.Order)
		if seg.AudioPath != nil && *seg.AudioPath != "" {
			segPath = *seg.AudioPath
		}
		tasks = append(tasks, segmentTask{
			idx: idx, voice: voice, synthVoice: plainVoice, altSynthVoice: altVoice,
			needPlain: !plainOK, needAlt: altVoice != "" && !altOK,
			segIdx: si, senIdx: senIdx,
			text:     strings.TrimSpace(sen.Text),
			segPath:  segPath,
			language: language,
			priority: priority,
		})
	}
	if reconciled {
		if err := r.withSave(ctx, nil); err != nil {
			return nil, err
		}
	}
	return tasks, nil
}

// renderChapter renders one chapter for one voice, fanning its sentences
// across every server the dispatcher grants (at most TtsConcurrency segment
// pipelines in flight), then assembles. pos is the job's position in the
// run's global order; +1 keeps priority 0 free for user-initiated edits.
func (w *Worker) renderChapter(ctx, stopCtx context.Context, r *run, j job, pos int, audioDir string, progress *renderProgress) error {
	voice, idx := j.voice, j.idx
	book := r.book
	chapter := &book.Chapters[idx]
	track := book.TrackForVoice(chapter, voice)
	if track == nil || track.AudioStatus == model.AudioComplete {
		return nil
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
			return err
		}
		w.emit(book, map[string]any{"chapterUpdate": chapterUpdate{Idx: idx, Voice: voice, AudioStatus: model.AudioError, AudioError: &audioError}})
		return nil
	}

	tasks, err := w.prepareChapterTasks(ctx, r, voice, idx, int64(pos)+1, audioDir, progress)
	if err != nil {
		return err
	}

	// Role/override voices can live on other engines — fail fast for those
	// models too, before any task is queued.
	missing := map[string]bool{}
	for _, t := range tasks {
		for _, v := range []string{t.synthVoice, t.altSynthVoice} {
			if v == "" {
				continue
			}
			if m, _ := tts.ParseVoice(v); !missing[m.ID] && !w.Q.Registry.HasModelWorker(m.ID) {
				missing[m.ID] = true
			}
		}
	}
	if len(missing) > 0 {
		ids := make([]string, 0, len(missing))
		for id := range missing {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		audioError := fmt.Sprintf("No TTS server is online for model %q — start the server and try again.", strings.Join(ids, ", "))
		log.Printf("renderChapter %s ch%d (%s): %s", book.ID.Hex(), idx+1, voice, audioError)
		if err := r.withSave(ctx, func() {
			track.AudioStatus = model.AudioError
			track.AudioError = &audioError
			progress.done++
		}); err != nil {
			return err
		}
		w.emit(book, map[string]any{"chapterUpdate": chapterUpdate{Idx: idx, Voice: voice, AudioStatus: model.AudioError, AudioError: &audioError}})
		return nil
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
		if err := w.renderSegment(ctx, stopCtx, r, task); err != nil {
			return err
		}
		emitChapterProgress()
		return nil
	})
	if err != nil {
		return err
	}

	// Assemble in the background: the merge only touches this chapter's
	// finished segments, so the fleet can start the model's next chapter
	// instead of idling behind ffmpeg.
	r.finalizeWG.Add(1)
	go func() {
		defer r.finalizeWG.Done()
		if err := w.finalizeTrack(ctx, r, idx, voice, audioDir, false); err != nil {
			log.Printf("finalizeTrack %s ch%d (%s): %v", book.ID.Hex(), idx+1, voice, err)
		}
	}()
	return nil
}

type job struct {
	voice string
	idx   int
}

const (
	jobPending = iota
	jobActive
	jobDone
)

// renderWork renders a worklist of (voice, chapter) jobs to completion, in
// worklist order: voices by insertion order, chapters in order.
//
// One chapter per model is in flight at a time, so every server able to run
// the current voice's model converges on that chapter (the dispatcher fans
// its segments across them) and the chapter becomes playable as soon as
// possible. A later job opens early only when some healthy server can't help
// with any chapter already in flight — that server works ahead alone on the
// first job it can render instead of idling. A job whose model no live
// server carries opens too: renderChapter fails it fast with a clear track
// error.
func (w *Worker) renderWork(ctx context.Context, r *run, audioDir string, progress *renderProgress, seed []job) error {
	if len(seed) == 0 {
		return nil
	}
	book := r.book

	// stopCtx unblocks renders parked in the dispatcher when the user stops
	// the run; saves keep using ctx so the unwind can still persist state.
	stopCtx, cancelStop := context.WithCancel(ctx)
	defer cancelStop()

	modelOf := func(voice string) string {
		m, _ := tts.ParseVoice(voice)
		return m.ID
	}

	status := make([]int, len(seed))
	type result struct {
		pos int
		err error
	}
	results := make(chan result)
	running := 0
	var firstErr error

	launch := func(pos int) {
		status[pos] = jobActive
		running++
		go func() {
			results <- result{pos, w.renderChapter(ctx, stopCtx, r, seed[pos], pos, audioDir, progress)}
		}()
	}

	schedule := func() {
		if firstErr != nil || w.stopRequested(book.ID.Hex()) {
			return
		}
		workers := w.Q.Registry.Workers(queue.RoleTTS)
		capableServers := func(m string) []string {
			var out []string
			for _, hb := range workers {
				if !hb.Healthy {
					continue
				}
				for _, adv := range hb.Models {
					if adv.ID == m {
						out = append(out, hb.ServerID)
						break
					}
				}
			}
			return out
		}

		activeModels := map[string]bool{}
		for pos, j := range seed {
			if status[pos] == jobActive {
				activeModels[modelOf(j.voice)] = true
			}
		}
		claimed := map[string]bool{}
		for pos, j := range seed {
			if status[pos] == jobDone {
				continue
			}
			m := modelOf(j.voice)
			capable := capableServers(m)
			if status[pos] == jobActive {
				for _, s := range capable {
					claimed[s] = true
				}
				continue
			}
			if activeModels[m] {
				continue
			}
			idle := len(capable) == 0
			for _, s := range capable {
				if !claimed[s] {
					idle = true
					break
				}
			}
			if idle {
				activeModels[m] = true
				for _, s := range capable {
					claimed[s] = true
				}
				launch(pos)
			}
		}
	}

	// The ticker re-runs scheduling so a server that comes online mid-run
	// picks up jobs that had no capable server, and turns a user stop into
	// stopCtx cancellation for renders parked in the dispatcher.
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	schedule()
	for running > 0 {
		select {
		case res := <-results:
			running--
			status[res.pos] = jobDone
			if res.err != nil && firstErr == nil {
				firstErr = res.err
			}
			schedule()
		case <-ticker.C:
			if w.stopRequested(book.ID.Hex()) {
				cancelStop()
			}
			schedule()
		}
	}
	r.finalizeWG.Wait()
	if firstErr == nil && w.stopRequested(book.ID.Hex()) {
		return ErrStopped
	}
	return firstErr
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
	defer w.publishRun(book.ID.Hex(), r)()
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
	defer w.publishRun(book.ID.Hex(), r)()

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
			chapter.Tracks[ti].Variants = nil
		}
	}); err != nil {
		return err
	}
	for _, voice := range book.Voices {
		os.RemoveAll(SegmentDir(audioDir, chapterIdx, voice))
		removeChapterFiles(audioDir, chapterIdx, voice)
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
		track.Variants = nil
	}
	os.RemoveAll(SegmentDir(audioDir, chapterIdx, voice))
	removeChapterFiles(audioDir, chapterIdx, voice)
}

// removeChapterFiles deletes a chapter track's assembled mp3s (all variants)
// and their timelines.
func removeChapterFiles(audioDir string, chapterIdx int, voice string) {
	for _, variant := range []string{"", "t", "q", "tq"} {
		p := ChapterAudioVariantPath(audioDir, chapterIdx, voice, variant)
		os.Remove(p)
		os.Remove(tts.TimelinePathFor(p))
	}
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
	defer w.publishRun(book.ID.Hex(), r)()

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
	defer w.publishRun(book.ID.Hex(), r)()

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
