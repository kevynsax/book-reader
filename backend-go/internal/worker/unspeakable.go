package worker

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/kevynsax/book-reader/backend-go/internal/model"
)

// isUnspeakable: a sentence the TTS server can't voice — no letters or
// digits, only leftover punctuation that sentence splitting stranded on its
// own line. Fish/openaudio errors on these, wedging the chapter.
func isUnspeakable(text string) bool {
	for _, r := range text {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			return false
		}
	}
	return true
}

// MigrateUnspeakableSentences repairs sentences that are pure punctuation by
// folding each back into the real sentence that precedes it, dropping the
// orphan, then re-rendering just the merged sentence. Idempotent.
func (w *Worker) MigrateUnspeakableSentences(ctx context.Context) error {
	books, err := w.St.Books.Find(ctx, bson.M{"deleted": bson.M{"$ne": true}}, nil)
	if err != nil {
		return err
	}
	fixedChapters := 0

	for _, book := range books {
		r := &run{w: w, book: book}
		audioDir := filepath.Join(book.FolderPath, "audio")
		type rerenderTarget struct {
			idx        int
			sentenceID string
		}
		var rerenderTargets []rerenderTarget
		var reassembleOnly []int
		var removedAudio []string
		bookTouched := false

		for idx := range book.Chapters {
			chapter := &book.Chapters[idx]
			ordered := append([]model.Sentence(nil), chapter.Sentences...)
			sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })
			garbageIDs := map[string]bool{}
			for _, s := range ordered {
				if isUnspeakable(s.Text) {
					garbageIDs[s.ID.Hex()] = true
				}
			}
			if len(garbageIDs) == 0 {
				continue
			}
			if len(garbageIDs) == len(ordered) {
				log.Printf("migrateUnspeakableSentences: %s ch%d is all punctuation; leaving as-is", book.ID.Hex(), idx+1)
				continue
			}

			targetIDs := map[string]bool{}
			for i := range ordered {
				if !garbageIDs[ordered[i].ID.Hex()] {
					continue
				}
				var target *model.Sentence
				for j := i - 1; j >= 0; j-- {
					if !garbageIDs[ordered[j].ID.Hex()] {
						target = &ordered[j]
						break
					}
				}
				if target == nil {
					continue // leading junk with no real sentence before it: just drop it
				}
				orphan := strings.TrimSpace(ordered[i].Text)
				prevText := strings.TrimSpace(target.Text)
				prevDisplay := prevText
				if target.Display != nil && strings.TrimSpace(*target.Display) != "" {
					prevDisplay = strings.TrimSpace(*target.Display)
				}
				merged := strings.TrimSpace(prevText + orphan)
				mergedDisplay := strings.TrimSpace(prevDisplay + orphan)
				target.Text = merged
				target.Display = &mergedDisplay
				targetIDs[target.ID.Hex()] = true
			}

			for ti := range chapter.Tracks {
				for si := range chapter.Tracks[ti].Segments {
					seg := &chapter.Tracks[ti].Segments[si]
					if targetIDs[seg.SentenceID.Hex()] {
						seg.AudioStatus = model.AudioStale
						seg.AudioError = nil
					}
					if garbageIDs[seg.SentenceID.Hex()] && seg.AudioPath != nil {
						removedAudio = append(removedAudio, *seg.AudioPath)
					}
				}
			}

			kept := make([]model.Sentence, 0, len(ordered)-len(garbageIDs))
			for _, s := range ordered {
				if !garbageIDs[s.ID.Hex()] {
					kept = append(kept, model.Sentence{ID: s.ID, Text: s.Text, Display: s.Display})
				}
			}
			for order := range kept {
				kept[order].Order = order
			}
			chapter.Sentences = kept

			for ti := range chapter.Tracks {
				track := &chapter.Tracks[ti]
				keptSegs := make([]model.Segment, 0, len(track.Segments))
				for _, s := range track.Segments {
					if !garbageIDs[s.SentenceID.Hex()] {
						keptSegs = append(keptSegs, s)
					}
				}
				track.Segments = keptSegs
			}

			if len(targetIDs) > 0 {
				for sentenceID := range targetIDs {
					rerenderTargets = append(rerenderTargets, rerenderTarget{idx: idx, sentenceID: sentenceID})
				}
			} else {
				reassembleOnly = append(reassembleOnly, idx)
			}
			bookTouched = true
			fixedChapters++
		}

		if !bookTouched {
			continue
		}

		if err := r.withSave(ctx, nil); err != nil {
			return err
		}
		w.emit(book, map[string]any{"chapters": model.SerializeChaptersForClient(book.Chapters)})
		for _, p := range removedAudio {
			os.Remove(p)
		}

		log.Printf("migrateUnspeakableSentences: %s — fixed unspeakable sentences in %d chapter(s)",
			book.ID.Hex(), len(rerenderTargets)+len(reassembleOnly))

		for _, t := range rerenderTargets {
			if err := w.rerenderSegment(ctx, r, t.idx, t.sentenceID, book.Voices); err != nil {
				log.Printf("migrateUnspeakableSentences rerender %s ch%d: %v", book.ID.Hex(), t.idx+1, err)
			}
		}
		for _, idx := range reassembleOnly {
			for _, voice := range book.Voices {
				_ = w.finalizeTrack(ctx, r, idx, voice, audioDir, false)
			}
		}
	}

	if fixedChapters > 0 {
		log.Printf("migrateUnspeakableSentences: repaired %d chapter(s)", fixedChapters)
	}
	return nil
}
