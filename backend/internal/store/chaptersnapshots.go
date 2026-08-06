package store

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/kevynsax/book-reader/backend/internal/model"
)

// ChapterSnapshots keeps one undo copy of a book's chapters — sentences and
// rendered segments included — taken when the user leaves sentence review to
// edit chapters/pages again. It lives outside the book document: books already
// run to ~11 MB, and a second copy of the chapters would risk the 16 MB cap.
type ChapterSnapshots struct {
	col *mongo.Collection
}

type chapterSnapshotDoc struct {
	BookID   bson.ObjectID   `bson:"_id"`
	Chapters []model.Chapter `bson:"chapters"`
	SavedAt  model.DateTime  `bson:"savedAt"`
}

func (s *ChapterSnapshots) Put(ctx context.Context, bookID bson.ObjectID, chapters []model.Chapter, savedAt model.DateTime) error {
	_, err := s.col.ReplaceOne(ctx, bson.M{"_id": bookID},
		chapterSnapshotDoc{BookID: bookID, Chapters: chapters, SavedAt: savedAt},
		options.Replace().SetUpsert(true))
	return err
}

// Get returns the snapshotted chapters, or nil when there is nothing to undo.
func (s *ChapterSnapshots) Get(ctx context.Context, bookID bson.ObjectID) ([]model.Chapter, error) {
	var doc chapterSnapshotDoc
	err := s.col.FindOne(ctx, bson.M{"_id": bookID}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return doc.Chapters, nil
}

func (s *ChapterSnapshots) Delete(ctx context.Context, bookID bson.ObjectID) error {
	_, err := s.col.DeleteOne(ctx, bson.M{"_id": bookID})
	return err
}
