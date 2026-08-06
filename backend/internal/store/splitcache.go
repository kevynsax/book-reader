package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// SplitCache stores SLM sentence-split results keyed by the exact input, so
// splits prefetched while pages are still being OCR'd (SLM servers are idle
// during that phase) are ready by the time generation builds the chapter.
type SplitCache struct {
	col *mongo.Collection
}

type splitCacheDoc struct {
	ID        string    `bson:"_id"`
	Line      string    `bson:"line"`
	Parts     []string  `bson:"parts"`
	CreatedAt time.Time `bson:"createdAt"`
}

func SplitCacheKey(model string, maxChars int, line string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%s", model, maxChars, line)))
	return hex.EncodeToString(sum[:])
}

// Get returns the cached parts, or nil when the line was never split.
func (s *SplitCache) Get(ctx context.Context, key string) []string {
	var doc splitCacheDoc
	err := s.col.FindOne(ctx, bson.M{"_id": key}).Decode(&doc)
	if err != nil {
		return nil
	}
	return doc.Parts
}

func (s *SplitCache) Put(ctx context.Context, key, line string, parts []string) {
	if len(parts) == 0 {
		return
	}
	_, err := s.col.UpdateByID(ctx, key, bson.M{"$set": splitCacheDoc{
		ID: key, Line: line, Parts: parts, CreatedAt: time.Now(),
	}}, options.UpdateOne().SetUpsert(true))
	if err != nil && !errors.Is(err, context.Canceled) {
		return
	}
}
