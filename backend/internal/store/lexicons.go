package store

import (
	"context"
	"errors"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/kevynsax/book-reader/backend/internal/model"
)

type Lexicons struct {
	col *mongo.Collection
}

func (l *Lexicons) All(ctx context.Context) ([]*model.Lexicon, error) {
	cur, err := l.col.Find(ctx, bson.M{}, options.Find().SetSort(bson.D{{Key: "language", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	var out []*model.Lexicon
	for cur.Next(ctx) {
		var lex model.Lexicon
		if err := cur.Decode(&lex); err != nil {
			return nil, err
		}
		if lex.Acronyms == nil {
			lex.Acronyms = []model.Acronym{}
		}
		out = append(out, &lex)
	}
	return out, cur.Err()
}

func (l *Lexicons) ByLanguage(ctx context.Context, language string) (*model.Lexicon, error) {
	var lex model.Lexicon
	err := l.col.FindOne(ctx, bson.M{"language": language}).Decode(&lex)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if lex.Acronyms == nil {
		lex.Acronyms = []model.Acronym{}
	}
	return &lex, nil
}

func (l *Lexicons) ReplaceAcronyms(ctx context.Context, language string, acronyms []model.Acronym) (*model.Lexicon, error) {
	if acronyms == nil {
		acronyms = []model.Acronym{}
	}
	now := bson.NewDateTimeFromTime(model.Now().Time)
	_, err := l.col.UpdateOne(ctx,
		bson.M{"language": language},
		bson.M{
			"$set":         bson.M{"acronyms": acronyms, "updatedAt": now},
			"$setOnInsert": bson.M{"language": language, "createdAt": now, "__v": int32(0)},
		},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return nil, err
	}
	return l.ByLanguage(ctx, language)
}

// Seed inserts the per-language default doc when missing, and adds any
// default terms absent from an existing doc without clobbering user edits
// (port of seedLexicons).
func (l *Lexicons) Seed(ctx context.Context) error {
	for language, acronyms := range model.DefaultAcronyms {
		now := bson.NewDateTimeFromTime(model.Now().Time)
		_, err := l.col.UpdateOne(ctx,
			bson.M{"language": language},
			bson.M{"$setOnInsert": bson.M{
				"language": language, "acronyms": acronyms,
				"createdAt": now, "updatedAt": now, "__v": int32(0),
			}},
			options.UpdateOne().SetUpsert(true),
		)
		if err != nil {
			return err
		}
		doc, err := l.ByLanguage(ctx, language)
		if err != nil || doc == nil {
			continue
		}
		have := map[string]bool{}
		for _, a := range doc.Acronyms {
			have[a.Term] = true
		}
		var missing []model.Acronym
		for _, a := range acronyms {
			if !have[a.Term] {
				missing = append(missing, a)
			}
		}
		if len(missing) > 0 {
			_, err = l.col.UpdateOne(ctx,
				bson.M{"language": language},
				bson.M{
					"$push": bson.M{"acronyms": bson.M{"$each": missing}},
					"$set":  bson.M{"updatedAt": bson.NewDateTimeFromTime(model.Now().Time)},
				},
			)
			if err != nil {
				return err
			}
		}
	}
	return nil
}
