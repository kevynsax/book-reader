package store

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/kevynsax/book-reader/backend/internal/lib/sanitize"
)

// The startup migrations operate on raw bson.D documents (not model.Book)
// because they must handle pre-schema shapes, exactly like Node's
// collection-level migrations in models/Book.ts.

func docGet(d bson.D, key string) (any, bool) {
	for _, e := range d {
		if e.Key == key {
			return e.Value, true
		}
	}
	return nil, false
}

// MigrateLegacyVoices folds the old single `voice` field into `voices[]` and
// per-chapter audioPath/audioStatus into a tracks[0].
func MigrateLegacyVoices(ctx context.Context, col *mongo.Collection) error {
	cur, err := col.Find(ctx, bson.M{"voices": bson.M{"$exists": false}})
	if err != nil {
		return err
	}
	defer cur.Close(ctx)

	for cur.Next(ctx) {
		var b bson.D
		if err := cur.Decode(&b); err != nil {
			return err
		}
		voice := "chatterbox:pt-BR-FranciscaNeural"
		if v, ok := docGet(b, "voice"); ok {
			if s, ok := v.(string); ok && s != "" {
				voice = s
			}
		}

		var chapters bson.A
		if v, ok := docGet(b, "chapters"); ok {
			if arr, ok := v.(bson.A); ok {
				chapters = arr
			}
		}
		migrated := make(bson.A, 0, len(chapters))
		for _, chAny := range chapters {
			ch, ok := chAny.(bson.D)
			if !ok {
				migrated = append(migrated, chAny)
				continue
			}
			if _, hasTracks := docGet(ch, "tracks"); hasTracks {
				migrated = append(migrated, ch)
				continue
			}
			track := bson.D{{Key: "voice", Value: voice}}
			if v, ok := docGet(ch, "audioPath"); ok {
				track = append(track, bson.E{Key: "audioPath", Value: v})
			}
			if v, ok := docGet(ch, "audioDurationSecs"); ok {
				track = append(track, bson.E{Key: "audioDurationSecs", Value: v})
			}
			status := any("pending")
			if v, ok := docGet(ch, "audioStatus"); ok {
				if s, isStr := v.(string); isStr && s != "" {
					status = v
				}
			}
			track = append(track, bson.E{Key: "audioStatus", Value: status})
			migrated = append(migrated, append(ch, bson.E{Key: "tracks", Value: bson.A{track}}))
		}

		id, _ := docGet(b, "_id")
		_, err := col.UpdateOne(ctx, bson.M{"_id": id}, bson.M{
			"$set":   bson.M{"voices": bson.A{voice}, "chapters": migrated},
			"$unset": bson.M{"voice": ""},
		})
		if err != nil {
			return err
		}
	}
	return cur.Err()
}

// MigrateSummaryPages folds the old single `summaryPage` into `summaryPages[]`.
func MigrateSummaryPages(ctx context.Context, col *mongo.Collection) error {
	cur, err := col.Find(ctx, bson.M{"summaryPages": bson.M{"$exists": false}})
	if err != nil {
		return err
	}
	defer cur.Close(ctx)

	for cur.Next(ctx) {
		var b bson.D
		if err := cur.Decode(&b); err != nil {
			return err
		}
		page := 0
		if v, ok := docGet(b, "summaryPage"); ok {
			switch n := v.(type) {
			case int32:
				page = int(n)
			case int64:
				page = int(n)
			case float64:
				page = int(n)
			}
		}
		pages := bson.A{}
		if page > 0 {
			pages = bson.A{page}
		}
		id, _ := docGet(b, "_id")
		_, err := col.UpdateOne(ctx, bson.M{"_id": id}, bson.M{
			"$set":   bson.M{"summaryPages": pages},
			"$unset": bson.M{"summaryPage": ""},
		})
		if err != nil {
			return err
		}
	}
	return cur.Err()
}

// MigrateSanitizeOcrText cleans ocrPages.text still holding raw JSON.
func MigrateSanitizeOcrText(ctx context.Context, col *mongo.Collection) error {
	cur, err := col.Find(ctx, bson.M{"ocrPages.text": bson.M{"$regex": `^\s*\{`}})
	if err != nil {
		return err
	}
	defer cur.Close(ctx)

	for cur.Next(ctx) {
		var b bson.D
		if err := cur.Decode(&b); err != nil {
			return err
		}
		var pages bson.A
		if v, ok := docGet(b, "ocrPages"); ok {
			if arr, ok := v.(bson.A); ok {
				pages = arr
			}
		}
		cleaned := make(bson.A, 0, len(pages))
		for _, pAny := range pages {
			p, ok := pAny.(bson.D)
			if !ok {
				cleaned = append(cleaned, pAny)
				continue
			}
			next := make(bson.D, 0, len(p))
			for _, e := range p {
				if e.Key == "text" {
					if s, ok := e.Value.(string); ok {
						e.Value = sanitize.PageText(s)
					}
				}
				next = append(next, e)
			}
			cleaned = append(cleaned, next)
		}
		id, _ := docGet(b, "_id")
		if _, err := col.UpdateOne(ctx, bson.M{"_id": id}, bson.M{"$set": bson.M{"ocrPages": cleaned}}); err != nil {
			return err
		}
	}
	return cur.Err()
}
