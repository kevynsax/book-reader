package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/kevynsax/book-reader/backend/internal/config"
	"github.com/kevynsax/book-reader/backend/internal/httpapi"
	"github.com/kevynsax/book-reader/backend/internal/queue"
	"github.com/kevynsax/book-reader/backend/internal/store"
	"github.com/kevynsax/book-reader/backend/internal/svc/normalizer"
	"github.com/kevynsax/book-reader/backend/internal/worker"
	"github.com/kevynsax/book-reader/backend/internal/ws"
)

// Startup mirrors backend/src/index.ts: connect → migrations → seed →
// mkdir → recoverInterruptedAudio → listen → background unspeakable migration.
//
// @version 2.5.1
func main() {
	config.Load()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	st, err := store.Connect(ctx, config.MongodbURI)
	cancel()
	if err != nil {
		log.Fatalf("Failed to connect to MongoDB: %v", err)
	}

	bg := context.Background()
	books := st.Books.Collection()
	if err := store.MigrateLegacyVoices(bg, books); err != nil {
		log.Fatalf("migrateLegacyVoices: %v", err)
	}
	if err := store.MigrateSummaryPages(bg, books); err != nil {
		log.Fatalf("migrateSummaryPages: %v", err)
	}
	if err := store.MigrateSanitizeOcrText(bg, books); err != nil {
		log.Fatalf("migrateSanitizeOcrText: %v", err)
	}
	if err := st.Lexicons.Seed(bg); err != nil {
		log.Fatalf("seedLexicons: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(config.DataDir, "books"), 0o755); err != nil {
		log.Fatalf("mkdir data dir: %v", err)
	}

	// Wire the DB-backed acronym cache into the normalizer and its
	// invalidation into the lexicon PUT route.
	lexCache := normalizer.NewLexCache(st)
	normalizer.AcronymsFor = lexCache.Get
	httpapi.InvalidateLexicon = lexCache.Invalidate

	hub := ws.NewHub([]string{config.FrontendOrigin, "localhost:*", "127.0.0.1:*"})
	ws.RegisterBookSync(hub, st)

	// The task fabric: every AI call is a queued task claimed by whichever
	// healthy role worker is free; heartbeats feed the worker registry.
	q := queue.NewClient(config.AmqpURL)

	w := worker.New(st, hub, q)
	handler := httpapi.New(st, hub, w)

	// Unstick any audio job a previous crash/restart left mid-flight so
	// finished chapters stay playable and the rest can be resumed.
	if err := w.RecoverInterruptedAudio(bg); err != nil {
		log.Printf("Failed to recover interrupted audio: %v", err)
	}

	// Repair pure-punctuation sentences in the background so it doesn't
	// delay startup.
	go func() {
		if err := w.MigrateUnspeakableSentences(bg); err != nil {
			log.Printf("Failed to migrate unspeakable sentences: %v", err)
		}
	}()

	addr := fmt.Sprintf(":%d", config.Port)
	log.Printf("Book Reader backend (Go) listening on port %d", config.Port)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatal(err)
	}
}
