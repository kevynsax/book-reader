package worker

import (
	"context"
	"strings"
	"time"

	"github.com/kevynsax/book-reader/backend/internal/config"
	"github.com/kevynsax/book-reader/backend/internal/store"
	"github.com/kevynsax/book-reader/backend/internal/svc/normalizer"
	"github.com/kevynsax/book-reader/backend/internal/svc/tts"
)

// slmSplitToMaxCached is the cache-first SLM split every split site uses: the
// import-time prefetcher fills the cache while pages are still being OCR'd,
// so generation finds most long lines already divided.
func (w *Worker) slmSplitToMaxCached(ctx context.Context, display string) []string {
	key := store.SplitCacheKey(config.SlmSplitModel, config.TtsMaxSentenceChars, display)
	if parts := w.St.SplitCache.Get(ctx, key); parts != nil {
		return parts
	}
	parts := tts.SlmSplitToMax(ctx, w.Q, display, config.TtsMaxSentenceChars)
	if parts != nil {
		w.St.SplitCache.Put(ctx, key, display, parts)
	}
	return parts
}

// At most this many prefetch splits run at once across all imports, so the
// warm-up never starves interactive SLM work.
var splitPrefetchSem = make(chan struct{}, 2)

// prefetchSplits warms the split cache for one OCR'd page: every line whose
// spoken form exceeds the TTS limit gets its SLM split computed now, in
// parallel with the remaining pages' OCR (vlm and slm run on different
// servers). Best-effort — failures just leave the line for generation time.
func (w *Worker) prefetchSplits(pageText, language string) {
	for _, line := range strings.Split(pageText, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		splitPrefetchSem <- struct{}{}
		func(line string) {
			defer func() { <-splitPrefetchSem }()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer cancel()
			norm := strings.TrimSpace(normalizer.NormalizeForSpeech(ctx, line, language))
			if len(utf16len(norm)) <= config.TtsMaxSentenceChars {
				return
			}
			_ = w.slmSplitToMaxCached(ctx, line)
		}(line)
	}
}
