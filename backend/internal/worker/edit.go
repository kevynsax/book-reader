package worker

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/kevynsax/book-reader/backend/internal/model"
	"github.com/kevynsax/book-reader/backend/internal/svc/normalizer"
	"github.com/kevynsax/book-reader/backend/internal/svc/tts"
)

// rerenderSegment re-synthesizes one sentence's segment for the given voices,
// then reassembles each affected chapter mp3. Shared by edit, insert and
// single-sentence regenerate. synthVoice, when set, is the voice actually
// synthesized (e.g. a different model to get past a stubborn mismatch) while
// the audio still lands in each target voice's track.
func (w *Worker) rerenderSegment(ctx context.Context, r *run, chapterIdx int, sentenceID string, voices []string, synthVoice string) error {
	book := r.book
	if chapterIdx < 0 || chapterIdx >= len(book.Chapters) {
		return nil
	}
	chapter := &book.Chapters[chapterIdx]
	senIdx := -1
	for i, s := range chapter.Sentences {
		if s.ID.Hex() == sentenceID {
			senIdx = i
			break
		}
	}
	if senIdx < 0 {
		return nil
	}

	w.ensureBookLanguage(ctx, r)

	audioDir := filepath.Join(book.FolderPath, "audio")
	language := chapterSpeechLanguage(book, chapterIdx)

	for _, voice := range voices {
		track := book.TrackForVoice(chapter, voice)
		if track == nil {
			continue
		}

		segIdx := -1
		if err := r.withSave(ctx, func() {
			ensureSegments(track, chapter)
			for i := range track.Segments {
				if track.Segments[i].SentenceID.Hex() == sentenceID {
					segIdx = i
					break
				}
			}
			if segIdx >= 0 {
				track.Segments[segIdx].AudioStatus = model.AudioGenerating
				track.Segments[segIdx].AudioError = nil
			}
		}); err != nil {
			return err
		}
		if segIdx < 0 {
			continue
		}
		w.emit(book, map[string]any{"segmentUpdate": segmentUpdate{
			ChapterIdx: chapterIdx, Voice: voice, SentenceID: sentenceID, AudioStatus: model.AudioGenerating,
		}})

		renderVoice := voice
		if synthVoice != "" {
			renderVoice = synthVoice
		}
		ttsModel, _ := tts.ParseVoice(renderVoice)
		if !w.Q.Registry.HasModelWorker(ttsModel.ID) {
			message := fmt.Sprintf("No TTS server is online for model %q.", ttsModel.ID)
			if err := r.withSave(ctx, func() {
				track.Segments[segIdx].AudioStatus = model.AudioError
				track.Segments[segIdx].AudioError = &message
			}); err != nil {
				return err
			}
			w.emit(book, map[string]any{"segmentUpdate": segmentUpdate{
				ChapterIdx: chapterIdx, Voice: voice, SentenceID: sentenceID,
				AudioStatus: model.AudioError, AudioError: &message,
			}})
			if err := w.finalizeTrack(ctx, r, chapterIdx, voice, audioDir, true); err != nil {
				return err
			}
			continue
		}

		sentence := chapter.Sentences[senIdx]
		segPath := segmentPathFor(track, segIdx, audioDir, chapterIdx, voice, sentence.Order)
		durationSecs, transcripts, mismatch, renderErr := tts.SynthesizeSegment(ctx, w.Q, strings.TrimSpace(sentence.Text), segPath, renderVoice, language)
		if err := r.withSave(ctx, func() {
			seg := &track.Segments[segIdx]
			if renderErr == nil {
				seg.AudioPath = &segPath
				seg.DurationSecs = &durationSecs
				seg.AudioStatus = model.AudioComplete
				seg.AudioError = nil
				seg.WhisperResults = transcripts
				seg.NeedsReview = mismatch
			} else {
				message := renderErr.Error()
				log.Printf("rerenderSegment %s ch%d (%s): %v", book.ID.Hex(), chapterIdx+1, voice, renderErr)
				seg.AudioStatus = model.AudioError
				seg.AudioError = &message
				seg.NeedsReview = false
			}
		}); err != nil {
			return err
		}
		seg := track.Segments[segIdx]
		w.emit(book, map[string]any{"segmentUpdate": segmentUpdate{
			ChapterIdx: chapterIdx, Voice: voice, SentenceID: sentenceID,
			AudioStatus: seg.AudioStatus, AudioError: seg.AudioError,
		}})
		if err := w.finalizeTrack(ctx, r, chapterIdx, voice, audioDir, true); err != nil {
			return err
		}
	}
	return nil
}

// segmentPathFor picks where a segment's audio lives: its existing file when
// it has one, the order-derived default otherwise — unless another segment in
// the track already owns that file (an inserted sentence shifted the orders),
// in which case the sentence id keys the name.
func segmentPathFor(track *model.VoiceTrack, segIdx int, audioDir string, chapterIdx int, voice string, order int) string {
	if track.Segments[segIdx].AudioPath != nil && *track.Segments[segIdx].AudioPath != "" {
		return *track.Segments[segIdx].AudioPath
	}
	segPath := segmentAudioPath(audioDir, chapterIdx, voice, order)
	for i := range track.Segments {
		if i != segIdx && track.Segments[i].AudioPath != nil && *track.Segments[i].AudioPath == segPath {
			return filepath.Join(SegmentDir(audioDir, chapterIdx, voice),
				fmt.Sprintf("seg-%s.mp3", track.Segments[segIdx].SentenceID.Hex()))
		}
	}
	return segPath
}

// EditSentence edits a sentence's text, then re-renders its segment for
// every voice. Queues behind any active generation run (LockBook) — an
// interleaved save here would erase the run's freshly rendered segments.
func (w *Worker) EditSentence(ctx context.Context, bookID string, chapterIdx int, sentenceID, text string) error {
	unlock := w.LockBook(bookID)
	defer unlock()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	if chapterIdx < 0 || chapterIdx >= len(book.Chapters) {
		return nil
	}
	r := &run{w: w, book: book}
	chapter := &book.Chapters[chapterIdx]

	senIdx := -1
	for i, s := range chapter.Sentences {
		if s.ID.Hex() == sentenceID {
			senIdx = i
			break
		}
	}
	if senIdx < 0 {
		return nil
	}

	trimmed := strings.TrimSpace(text)
	if err := r.withSave(ctx, func() {
		d := trimmed
		chapter.Sentences[senIdx].Text = trimmed
		chapter.Sentences[senIdx].Display = &d
		for ti := range chapter.Tracks {
			for si := range chapter.Tracks[ti].Segments {
				if chapter.Tracks[ti].Segments[si].SentenceID.Hex() == sentenceID {
					chapter.Tracks[ti].Segments[si].AudioStatus = model.AudioStale
					chapter.Tracks[ti].Segments[si].AudioError = nil
				}
			}
		}
	}); err != nil {
		return err
	}
	w.emit(book, map[string]any{"sentenceUpdate": map[string]any{
		"chapterIdx": chapterIdx, "sentenceId": sentenceID, "text": trimmed,
	}})

	return w.rerenderSegment(ctx, r, chapterIdx, sentenceID, book.Voices, "")
}

// InsertSentence creates a new sentence right after an existing one and
// renders it for every voice — the manual alternative to the old automatic
// SLM split. Queues behind any active generation run.
func (w *Worker) InsertSentence(ctx context.Context, bookID string, chapterIdx int, afterSentenceID, text string) error {
	unlock := w.LockBook(bookID)
	defer unlock()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	if chapterIdx < 0 || chapterIdx >= len(book.Chapters) {
		return nil
	}
	r := &run{w: w, book: book}
	chapter := &book.Chapters[chapterIdx]

	afterIdx := -1
	for i, s := range chapter.Sentences {
		if s.ID.Hex() == afterSentenceID {
			afterIdx = i
			break
		}
	}
	if afterIdx < 0 {
		return nil
	}

	w.ensureBookLanguage(ctx, r)
	language := chapterSpeechLanguage(book, chapterIdx)
	trimmed := strings.TrimSpace(text)
	norm := strings.TrimSpace(normalizer.NormalizeForSpeech(ctx, trimmed, language))
	if norm == "" {
		norm = trimmed
	}

	d := trimmed
	newSen := model.Sentence{ID: bson.NewObjectID(), Text: norm, Display: &d}
	if err := r.withSave(ctx, func() {
		afterOrder := chapter.Sentences[afterIdx].Order
		for i := range chapter.Sentences {
			if chapter.Sentences[i].Order > afterOrder {
				chapter.Sentences[i].Order++
			}
		}
		newSen.Order = afterOrder + 1
		chapter.Sentences = append(chapter.Sentences, newSen)
		sort.SliceStable(chapter.Sentences, func(i, j int) bool { return chapter.Sentences[i].Order < chapter.Sentences[j].Order })
		for ti := range chapter.Tracks {
			ensureSegments(&chapter.Tracks[ti], chapter)
		}
	}); err != nil {
		return err
	}
	w.emit(book, map[string]any{"chapters": model.SerializeChaptersForClient(book.Chapters)})

	return w.rerenderSegment(ctx, r, chapterIdx, newSen.ID.Hex(), book.Voices, "")
}

// DeleteSentence deletes a sentence and reassembles each voice from the
// remaining cached segments. Queues behind any active generation run.
func (w *Worker) DeleteSentence(ctx context.Context, bookID string, chapterIdx int, sentenceID string) error {
	unlock := w.LockBook(bookID)
	defer unlock()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	if chapterIdx < 0 || chapterIdx >= len(book.Chapters) {
		return nil
	}
	r := &run{w: w, book: book}
	chapter := &book.Chapters[chapterIdx]

	found := false
	for _, s := range chapter.Sentences {
		if s.ID.Hex() == sentenceID {
			found = true
			break
		}
	}
	if !found || len(chapter.Sentences) <= 1 {
		return nil
	}

	audioDir := filepath.Join(book.FolderPath, "audio")
	var deletedAudio []string
	for _, t := range chapter.Tracks {
		for _, s := range t.Segments {
			if s.SentenceID.Hex() == sentenceID && s.AudioPath != nil {
				deletedAudio = append(deletedAudio, *s.AudioPath)
			}
		}
	}

	if err := r.withSave(ctx, func() {
		kept := make([]model.Sentence, 0, len(chapter.Sentences)-1)
		for _, s := range chapter.Sentences {
			if s.ID.Hex() != sentenceID {
				kept = append(kept, s)
			}
		}
		sort.SliceStable(kept, func(i, j int) bool { return kept[i].Order < kept[j].Order })
		for order := range kept {
			kept[order] = model.Sentence{ID: kept[order].ID, Order: order, Text: kept[order].Text, Display: kept[order].Display, Original: kept[order].Original, TraceOrder: kept[order].TraceOrder, SplitOf: kept[order].SplitOf, SplitCreatedWhen: kept[order].SplitCreatedWhen}
		}
		chapter.Sentences = kept

		for ti := range chapter.Tracks {
			track := &chapter.Tracks[ti]
			keptSegs := make([]model.Segment, 0, len(track.Segments))
			for _, s := range track.Segments {
				if s.SentenceID.Hex() != sentenceID {
					keptSegs = append(keptSegs, s)
				}
			}
			track.Segments = keptSegs
		}
	}); err != nil {
		return err
	}
	w.emit(book, map[string]any{
		"sentenceDeleted": map[string]any{"chapterIdx": chapterIdx, "sentenceId": sentenceID},
		"chapters":        model.SerializeChaptersForClient(book.Chapters),
	})

	for _, p := range deletedAudio {
		os.Remove(p)
	}

	for _, voice := range book.Voices {
		if err := w.finalizeTrack(ctx, r, chapterIdx, voice, audioDir, false); err != nil {
			return err
		}
	}
	return nil
}

// ApproveSentence clears the needs-review flag on a sentence's segments (all
// voices, or just one when voice is set) — the user listened and the audio is
// fine as-is.
func (w *Worker) ApproveSentence(ctx context.Context, bookID string, chapterIdx int, sentenceID, voice string) error {
	unlock := w.LockBook(bookID)
	defer unlock()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	if chapterIdx < 0 || chapterIdx >= len(book.Chapters) {
		return nil
	}
	r := &run{w: w, book: book}
	chapter := &book.Chapters[chapterIdx]
	changed := false
	if err := r.withSave(ctx, func() {
		for ti := range chapter.Tracks {
			track := &chapter.Tracks[ti]
			if voice != "" && track.Voice != voice {
				continue
			}
			for si := range track.Segments {
				seg := &track.Segments[si]
				if seg.SentenceID.Hex() == sentenceID && seg.NeedsReview {
					seg.NeedsReview = false
					changed = true
				}
			}
		}
	}); err != nil {
		return err
	}
	if changed {
		w.emit(book, map[string]any{"chapters": model.SerializeChaptersForClient(book.Chapters)})
	}
	return nil
}

// RegenerateSegment re-renders one sentence's segment without changing its
// text (e.g. it errored or mismatched). synthVoice, when set, synthesizes
// with a different voice/model while keeping the audio in the target voice's
// track. Queues behind any active generation run.
func (w *Worker) RegenerateSegment(ctx context.Context, bookID string, chapterIdx int, sentenceID, voice, synthVoice string) error {
	unlock := w.LockBook(bookID)
	defer unlock()
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	r := &run{w: w, book: book}
	voices := book.Voices
	if voice != "" {
		voices = []string{voice}
	}
	return w.rerenderSegment(ctx, r, chapterIdx, sentenceID, voices, synthVoice)
}
