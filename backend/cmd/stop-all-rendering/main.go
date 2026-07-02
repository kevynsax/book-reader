// stop-all-rendering resets all `generating` tracks/segments in the DB to
// stale/pending and unsticks books (mirrors finalizeStop, for when the server
// isn't running). Port of src/scripts/stopAllRendering.ts.
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/kevynsax/book-reader/backend/internal/config"
	"github.com/kevynsax/book-reader/backend/internal/model"
	"github.com/kevynsax/book-reader/backend/internal/store"
)

func main() {
	config.Load()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	st, err := store.Connect(ctx, config.MongodbURI)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer st.Client.Disconnect(ctx)

	books, err := st.Books.Find(ctx, bson.M{}, nil)
	if err != nil {
		log.Fatalf("find: %v", err)
	}

	touchedBooks, tracks, segments := 0, 0, 0
	for _, book := range books {
		changed := false
		for ci := range book.Chapters {
			for ti := range book.Chapters[ci].Tracks {
				track := &book.Chapters[ci].Tracks[ti]
				if track.AudioStatus == model.AudioGenerating {
					track.AudioStatus = model.AudioStale
					tracks++
					changed = true
				}
				for si := range track.Segments {
					if track.Segments[si].AudioStatus == model.AudioGenerating {
						track.Segments[si].AudioStatus = model.AudioPending
						segments++
						changed = true
					}
				}
			}
		}
		if book.Status == model.StatusGeneratingAudio {
			book.Status = model.StatusComplete
			book.Progress.Message = "Stopped."
			changed = true
		}
		if changed {
			if err := st.Books.Save(ctx, book); err != nil {
				log.Fatalf("save %s: %v", book.ID.Hex(), err)
			}
			touchedBooks++
			name := book.Name
			if name == "" {
				name = book.ID.Hex()
			}
			fmt.Printf("stopped rendering: %s\n", name)
		}
	}
	fmt.Printf("\nDone. %d book(s) updated — %d track(s) and %d segment(s) cleared.\n", touchedBooks, tracks, segments)
}
