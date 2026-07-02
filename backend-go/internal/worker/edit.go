package worker

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kevynsax/book-reader/backend-go/internal/model"
	"github.com/kevynsax/book-reader/backend-go/internal/queue"
	"github.com/kevynsax/book-reader/backend-go/internal/svc/tts"
)

// rerenderSegment re-synthesizes one sentence's segment for the given voices,
// then reassembles each affected chapter mp3. Shared by edit +
// single-sentence regenerate.
func (w *Worker) rerenderSegment(ctx context.Context, r *run, chapterIdx int, sentenceID string, voices []string) error {
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

		ttsModel, _ := tts.ParseVoice(voice)
		if !w.Q.Registry.HasHealthy(queue.RoleTTS) {
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
		segPath := segmentAudioPath(audioDir, chapterIdx, voice, sentence.Order)
		durationSecs, renderErr := tts.SynthesizeSegment(ctx, w.Q, strings.TrimSpace(sentence.Text), segPath, voice, language)
		if err := r.withSave(ctx, func() {
			seg := &track.Segments[segIdx]
			if renderErr == nil {
				seg.AudioPath = &segPath
				seg.DurationSecs = &durationSecs
				seg.AudioStatus = model.AudioComplete
				seg.AudioError = nil
			} else {
				message := renderErr.Error()
				log.Printf("rerenderSegment %s ch%d (%s): %v", book.ID.Hex(), chapterIdx+1, voice, renderErr)
				seg.AudioStatus = model.AudioError
				seg.AudioError = &message
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

// EditSentence edits a sentence's text, then re-renders its segment for
// every voice.
func (w *Worker) EditSentence(ctx context.Context, bookID string, chapterIdx int, sentenceID, text string) error {
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

	return w.rerenderSegment(ctx, r, chapterIdx, sentenceID, book.Voices)
}

// DeleteSentence deletes a sentence and reassembles each voice from the
// remaining cached segments.
func (w *Worker) DeleteSentence(ctx context.Context, bookID string, chapterIdx int, sentenceID string) error {
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
			kept[order] = model.Sentence{ID: kept[order].ID, Order: order, Text: kept[order].Text, Display: kept[order].Display}
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

// RegenerateSegment re-renders one sentence's segment without changing its
// text (e.g. it errored).
func (w *Worker) RegenerateSegment(ctx context.Context, bookID string, chapterIdx int, sentenceID, voice string) error {
	book, err := w.St.Books.FindByID(ctx, bookID)
	if err != nil || book == nil {
		return err
	}
	r := &run{w: w, book: book}
	voices := book.Voices
	if voice != "" {
		voices = []string{voice}
	}
	return w.rerenderSegment(ctx, r, chapterIdx, sentenceID, voices)
}
