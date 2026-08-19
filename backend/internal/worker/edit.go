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
// the audio still lands in each target voice's track. merge=false renders the
// segment only, leaving the chapter mp3 for a later finalize.
func (w *Worker) rerenderSegment(ctx context.Context, r *run, chapterIdx int, sentenceID string, voices []string, synthVoice string, merge bool) error {
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

		sen := chapter.Sentences[senIdx]
		renderVoice := sen.SynthVoiceFor(voice, book.VoiceRoles, false)
		altVoice := sen.SynthVoiceFor(voice, book.VoiceRoles, true)
		if synthVoice != "" {
			// An explicit escape-hatch voice replaces both takes.
			renderVoice = synthVoice
			altVoice = synthVoice
		}
		if altVoice == renderVoice {
			altVoice = ""
		}
		missingModel := ""
		for _, v := range []string{renderVoice, altVoice} {
			if v == "" {
				continue
			}
			if m, _ := tts.ParseVoice(v); !w.Q.Registry.HasModelWorker(m.ID) {
				missingModel = m.ID
				break
			}
		}
		if missingModel != "" {
			message := fmt.Sprintf("No TTS server is online for model %q.", missingModel)
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
			if merge {
				if err := w.finalizeTrack(ctx, r, chapterIdx, voice, audioDir, true); err != nil {
					return err
				}
			}
			continue
		}

		sentence := chapter.Sentences[senIdx]
		segPath := segmentPathFor(track, segIdx, audioDir, chapterIdx, voice, sentence.Order)
		text := strings.TrimSpace(sentence.Text)
		durationSecs, transcripts, mismatch, renderErr := tts.SynthesizeSegment(ctx, w.Q, text, segPath, renderVoice, language)
		altPath := altPathFor(segPath)
		var altDur float64
		var altMismatch bool
		if renderErr == nil && altVoice != "" {
			var altTranscripts []string
			altDur, altTranscripts, altMismatch, renderErr = tts.SynthesizeSegment(ctx, w.Q, text, altPath, altVoice, language)
			transcripts = append(transcripts, altTranscripts...)
		}
		if err := r.withSave(ctx, func() {
			seg := &track.Segments[segIdx]
			if renderErr == nil {
				seg.AudioPath = &segPath
				seg.DurationSecs = &durationSecs
				seg.AudioStatus = model.AudioComplete
				seg.AudioError = nil
				seg.WhisperResults = transcripts
				seg.NeedsReview = mismatch || altMismatch
				if altVoice != "" {
					seg.AltAudioPath = &altPath
					seg.AltDurationSecs = &altDur
					seg.AltVoice = altVoice
				} else {
					seg.AltAudioPath = nil
					seg.AltDurationSecs = nil
					seg.AltVoice = ""
				}
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
		if merge {
			if err := w.finalizeTrack(ctx, r, chapterIdx, voice, audioDir, true); err != nil {
				return err
			}
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
// every voice. Joins an active generation run rather than waiting it out, so
// the user sees the change right away.
// renderNow: re-render the touched segments immediately (they jump the
// dispatcher queue at priority 0). When false the segments just go stale and
// the next generate/continue picks them up in batch.
func (w *Worker) EditSentence(ctx context.Context, bookID string, chapterIdx int, sentenceID, text string, renderNow bool) error {
	return w.withBookRun(ctx, bookID, func(r *run) error {
		return w.editSentence(ctx, r, chapterIdx, sentenceID, text, renderNow)
	})
}

func (w *Worker) editSentence(ctx context.Context, r *run, chapterIdx int, sentenceID, text string, renderNow bool) error {
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

	if !renderNow {
		return nil
	}
	return w.rerenderSegment(ctx, r, chapterIdx, sentenceID, book.Voices, "", true)
}

// InsertSentence creates a new sentence next to an existing one (before it
// when before is set, after it otherwise) and renders it for every voice — the
// manual alternative to the old automatic SLM split. Joins an active
// generation run.
func (w *Worker) InsertSentence(ctx context.Context, bookID string, chapterIdx int, anchorSentenceID, text string, before, renderNow bool) error {
	return w.withBookRun(ctx, bookID, func(r *run) error {
		return w.insertSentence(ctx, r, chapterIdx, anchorSentenceID, text, before, renderNow)
	})
}

func (w *Worker) insertSentence(ctx context.Context, r *run, chapterIdx int, anchorSentenceID, text string, before, renderNow bool) error {
	book := r.book
	if chapterIdx < 0 || chapterIdx >= len(book.Chapters) {
		return nil
	}
	chapter := &book.Chapters[chapterIdx]

	anchorIdx := -1
	for i, s := range chapter.Sentences {
		if s.ID.Hex() == anchorSentenceID {
			anchorIdx = i
			break
		}
	}
	if anchorIdx < 0 {
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
		anchorOrder := chapter.Sentences[anchorIdx].Order
		newOrder := anchorOrder + 1
		if before {
			newOrder = anchorOrder
		}
		for i := range chapter.Sentences {
			if chapter.Sentences[i].Order >= newOrder {
				chapter.Sentences[i].Order++
			}
		}
		newSen.Order = newOrder
		chapter.Sentences = append(chapter.Sentences, newSen)
		sort.SliceStable(chapter.Sentences, func(i, j int) bool { return chapter.Sentences[i].Order < chapter.Sentences[j].Order })
		for ti := range chapter.Tracks {
			ensureSegments(&chapter.Tracks[ti], chapter)
		}
	}); err != nil {
		return err
	}
	w.emit(book, map[string]any{"chapters": model.SerializeChaptersForClient(book.Chapters)})

	if !renderNow {
		return nil
	}
	return w.rerenderSegment(ctx, r, chapterIdx, newSen.ID.Hex(), book.Voices, "", true)
}

// DeleteSentence deletes a sentence and reassembles each voice from the
// remaining cached segments. Joins an active generation run.
func (w *Worker) DeleteSentence(ctx context.Context, bookID string, chapterIdx int, sentenceID string) error {
	return w.withBookRun(ctx, bookID, func(r *run) error {
		return w.deleteSentence(ctx, r, chapterIdx, sentenceID)
	})
}

func (w *Worker) deleteSentence(ctx context.Context, r *run, chapterIdx int, sentenceID string) error {
	book := r.book
	if chapterIdx < 0 || chapterIdx >= len(book.Chapters) {
		return nil
	}
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
			if s.SentenceID.Hex() == sentenceID {
				if s.AudioPath != nil {
					deletedAudio = append(deletedAudio, *s.AudioPath)
				}
				if s.AltAudioPath != nil {
					deletedAudio = append(deletedAudio, *s.AltAudioPath)
				}
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
			kept[order] = model.Sentence{ID: kept[order].ID, Order: order, Text: kept[order].Text, Display: kept[order].Display, Original: kept[order].Original, TraceOrder: kept[order].TraceOrder, SplitOf: kept[order].SplitOf, SplitCreatedWhen: kept[order].SplitCreatedWhen, VoiceOverrides: kept[order].VoiceOverrides, Role: kept[order].Role}
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
	return w.withBookRun(ctx, bookID, func(r *run) error {
		return w.approveSentence(ctx, r, chapterIdx, sentenceID, voice)
	})
}

func (w *Worker) approveSentence(ctx context.Context, r *run, chapterIdx int, sentenceID, voice string) error {
	book := r.book
	if chapterIdx < 0 || chapterIdx >= len(book.Chapters) {
		return nil
	}
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
// track. Joins an active generation run so a review-page re-render is heard
// right away instead of after the whole book.
func (w *Worker) RegenerateSegment(ctx context.Context, bookID string, chapterIdx int, sentenceID, voice, synthVoice string, merge bool) error {
	return w.withBookRun(ctx, bookID, func(r *run) error {
		voices := r.book.Voices
		if voice != "" {
			voices = []string{voice}
		}
		return w.rerenderSegment(ctx, r, chapterIdx, sentenceID, voices, synthVoice, merge)
	})
}

// SetVoiceOverride pins (or clears, when synthVoice is empty) the voice that
// speaks one sentence. voice is the book voice whose track it applies to, or
// model.AllVoices for every track — a quote read by someone else. The touched
// segments go stale; the caller re-renders them.
func (w *Worker) SetVoiceOverride(ctx context.Context, bookID string, chapterIdx int, sentenceID, voice, synthVoice string) error {
	return w.withBookRun(ctx, bookID, func(r *run) error {
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
		if err := r.withSave(ctx, func() {
			sen := &chapter.Sentences[senIdx]
			if synthVoice == "" {
				delete(sen.VoiceOverrides, voice)
				if len(sen.VoiceOverrides) == 0 {
					sen.VoiceOverrides = nil
				}
			} else {
				if sen.VoiceOverrides == nil {
					sen.VoiceOverrides = map[string]string{}
				}
				sen.VoiceOverrides[voice] = synthVoice
			}
			for ti := range chapter.Tracks {
				track := &chapter.Tracks[ti]
				if voice != model.AllVoices && track.Voice != voice {
					continue
				}
				for si := range track.Segments {
					seg := &track.Segments[si]
					if seg.SentenceID.Hex() == sentenceID && seg.AudioStatus == model.AudioComplete {
						seg.AudioStatus = model.AudioStale
					}
				}
			}
		}); err != nil {
			return err
		}
		w.emit(book, map[string]any{"chapters": model.SerializeChaptersForClient(book.Chapters)})
		return nil
	})
}

// FinalizeChapter reassembles every voice's chapter mp3 from the cached
// segments — the merge step the review page defers until save.
func (w *Worker) FinalizeChapter(ctx context.Context, bookID string, chapterIdx int) error {
	return w.withBookRun(ctx, bookID, func(r *run) error {
		book := r.book
		if chapterIdx < 0 || chapterIdx >= len(book.Chapters) {
			return nil
		}
		audioDir := filepath.Join(book.FolderPath, "audio")
		for _, voice := range book.Voices {
			if err := w.finalizeTrack(ctx, r, chapterIdx, voice, audioDir, true); err != nil {
				return err
			}
		}
		return nil
	})
}

// ApplyVoiceRoles replaces the book's role→voice configuration. VoiceRoles is
// persisted via UpdateByID (never the SaveGeneration allowlist — a running
// render must not clobber it), then every complete segment whose alt take is
// affected by the diff goes stale so the next generate/continue re-renders
// just those takes.
func (w *Worker) ApplyVoiceRoles(ctx context.Context, bookID string, roles map[string]model.RoleVoices) error {
	return w.withBookRun(ctx, bookID, func(r *run) error {
		book := r.book
		old := book.VoiceRoles

		if err := w.St.Books.SetVoiceRoles(ctx, book.ID, roles); err != nil {
			return err
		}

		if err := r.withSave(ctx, func() {
			book.VoiceRoles = roles
			for ci := range book.Chapters {
				chapter := &book.Chapters[ci]
				senByID := map[string]*model.Sentence{}
				for si := range chapter.Sentences {
					senByID[chapter.Sentences[si].ID.Hex()] = &chapter.Sentences[si]
				}
				for ti := range chapter.Tracks {
					track := &chapter.Tracks[ti]
					touched := false
					for si := range track.Segments {
						seg := &track.Segments[si]
						sen := senByID[seg.SentenceID.Hex()]
						if sen == nil || sen.Role == model.RoleNone {
							continue
						}
						if old[track.Voice][sen.Role] == roles[track.Voice][sen.Role] {
							continue
						}
						if seg.AudioStatus == model.AudioComplete {
							seg.AudioStatus = model.AudioStale
							seg.AudioError = nil
							touched = true
						}
					}
					if touched && track.AudioStatus == model.AudioComplete {
						track.AudioStatus = model.AudioStale
					}
				}
			}
		}); err != nil {
			return err
		}
		w.emit(book, map[string]any{
			"voiceRoles": roles,
			"chapters":   model.SerializeChaptersForClient(book.Chapters),
		})
		return nil
	})
}

// SetSentenceRole classifies (or clears) one sentence's role. Complete
// segments whose alt take changes with the new role go stale so the next
// render/regenerate refreshes them.
func (w *Worker) SetSentenceRole(ctx context.Context, bookID string, chapterIdx int, sentenceID string, role model.SentenceRole) error {
	return w.withBookRun(ctx, bookID, func(r *run) error {
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
		if err := r.withSave(ctx, func() {
			sen := &chapter.Sentences[senIdx]
			old := sen.Role
			sen.Role = role
			for ti := range chapter.Tracks {
				track := &chapter.Tracks[ti]
				oldAlt := roleVoiceFor(book.VoiceRoles, track.Voice, old)
				newAlt := roleVoiceFor(book.VoiceRoles, track.Voice, role)
				if oldAlt == newAlt {
					continue
				}
				touched := false
				for si := range track.Segments {
					seg := &track.Segments[si]
					if seg.SentenceID.Hex() == sentenceID && seg.AudioStatus == model.AudioComplete {
						seg.AudioStatus = model.AudioStale
						seg.AudioError = nil
						touched = true
					}
				}
				if touched && track.AudioStatus == model.AudioComplete {
					track.AudioStatus = model.AudioStale
				}
			}
		}); err != nil {
			return err
		}
		w.emit(book, map[string]any{"chapters": model.SerializeChaptersForClient(book.Chapters)})
		return nil
	})
}

func roleVoiceFor(roles map[string]model.RoleVoices, trackVoice string, role model.SentenceRole) string {
	if role == model.RoleNone {
		return ""
	}
	return roles[trackVoice][role]
}
