package normalizer

import (
	"context"
	"sync"

	"github.com/kevynsax/book-reader/backend/internal/model"
	"github.com/kevynsax/book-reader/backend/internal/store"
)

// LexCache is the in-memory acronym cache (single backend process),
// invalidated by the lexicon PUT route after edits.
type LexCache struct {
	mu    sync.Mutex
	st    *store.Store
	cache map[string][]model.Acronym
}

func NewLexCache(st *store.Store) *LexCache {
	return &LexCache{st: st, cache: map[string][]model.Acronym{}}
}

func (l *LexCache) Get(ctx context.Context, language string) []model.Acronym {
	l.mu.Lock()
	if cached, ok := l.cache[language]; ok {
		l.mu.Unlock()
		return cached
	}
	l.mu.Unlock()

	acronyms := []model.Acronym{}
	if doc, err := l.st.Lexicons.ByLanguage(ctx, language); err == nil && doc != nil {
		acronyms = doc.Acronyms
	}
	l.mu.Lock()
	l.cache[language] = acronyms
	l.mu.Unlock()
	return acronyms
}

func (l *LexCache) Invalidate(language string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if language != "" {
		delete(l.cache, language)
	} else {
		l.cache = map[string][]model.Acronym{}
	}
}
