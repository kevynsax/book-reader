package store

import (
	"context"
	"errors"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/kevynsax/book-reader/backend/internal/model"
)

type Books struct {
	col *mongo.Collection
}

func (b *Books) Collection() *mongo.Collection { return b.col }

// FindByID returns (nil, nil) when the id is invalid hex or no document
// matches — mirroring Node's `Book.findById` falsy paths.
func (b *Books) FindByID(ctx context.Context, id string) (*model.Book, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, nil
	}
	var book model.Book
	err = b.col.FindOne(ctx, bson.M{"_id": oid}).Decode(&book)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	book.Normalize()
	return &book, nil
}

func (b *Books) Find(ctx context.Context, filter any, sort any) ([]*model.Book, error) {
	opts := options.Find()
	if sort != nil {
		opts.SetSort(sort)
	}
	cur, err := b.col.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	var books []*model.Book
	for cur.Next(ctx) {
		var book model.Book
		if err := cur.Decode(&book); err != nil {
			return nil, err
		}
		book.Normalize()
		books = append(books, &book)
	}
	return books, cur.Err()
}

// Insert assigns _id/timestamps/__v like Mongoose's create.
func (b *Books) Insert(ctx context.Context, book *model.Book) error {
	if book.ID.IsZero() {
		book.ID = bson.NewObjectID()
	}
	now := model.Now()
	book.CreatedAt = now
	book.UpdatedAt = now
	book.V = 0
	book.Normalize()
	_, err := b.col.InsertOne(ctx, book)
	return err
}

// Save replaces the whole document — the equivalent of Mongoose doc.save():
// the in-memory document wins. Reserved for flows that own the entire
// document (upload, guarded chapter/page rewrites); everything else must use
// SaveGeneration or UpdateByID so it can never revert fields written by a
// concurrent flow.
func (b *Books) Save(ctx context.Context, book *model.Book) error {
	book.UpdatedAt = model.Now()
	book.Normalize()
	_, err := b.col.ReplaceOne(ctx, bson.M{"_id": book.ID}, book)
	return err
}

// SaveGeneration persists only the fields generation/import runs own. A run
// used to ReplaceOne its whole in-memory copy on every segment, silently
// reverting any rename/voice-add/delete that landed since the run loaded the
// book — hours of rendered segments could vanish the same way when two runs
// interleaved. Field-scoping the write ends the cross-field clobbering; the
// per-book run lock ends run-vs-run interleaving.
func (b *Books) SaveGeneration(ctx context.Context, book *model.Book) error {
	book.UpdatedAt = model.Now()
	book.Normalize()
	set := bson.M{
		"chapters":   book.Chapters,
		"ocrPages":   book.OcrPages,
		"progress":   book.Progress,
		"status":     book.Status,
		"totalPages": book.TotalPages,
		"name":       book.Name,
		"updatedAt":  bson.NewDateTimeFromTime(book.UpdatedAt.Time),
	}
	unset := bson.M{}
	if book.ErrorMessage != nil {
		set["errorMessage"] = *book.ErrorMessage
	} else {
		unset["errorMessage"] = ""
	}
	if book.Language != nil {
		set["language"] = *book.Language
	}
	if book.CoverImagePath != nil {
		set["coverImagePath"] = *book.CoverImagePath
	}
	update := bson.M{"$set": set}
	if len(unset) > 0 {
		update["$unset"] = unset
	}
	_, err := b.col.UpdateOne(ctx, bson.M{"_id": book.ID}, update)
	return err
}

// UpdateByID applies a targeted update and stamps updatedAt (returned for WS
// emits). Routes use this for small edits so they can't clobber the chapter
// state an active generation run is writing.
func (b *Books) UpdateByID(ctx context.Context, id bson.ObjectID, update bson.M, arrayFilters ...any) (model.DateTime, error) {
	now := model.Now()
	set, _ := update["$set"].(bson.M)
	if set == nil {
		set = bson.M{}
	}
	set["updatedAt"] = bson.NewDateTimeFromTime(now.Time)
	update["$set"] = set

	var opts []options.Lister[options.UpdateOneOptions]
	if len(arrayFilters) > 0 {
		opts = append(opts, options.UpdateOne().SetArrayFilters(arrayFilters))
	}
	_, err := b.col.UpdateOne(ctx, bson.M{"_id": id}, update, opts...)
	return now, err
}

// SetChapters is the targeted-update exception (PATCH /:id/chapters uses
// findByIdAndUpdate in Node).
func (b *Books) SetChapters(ctx context.Context, id bson.ObjectID, chapters []model.Chapter) error {
	_, err := b.col.UpdateOne(ctx, bson.M{"_id": id}, bson.M{
		"$set":         bson.M{"chapters": chapters},
		"$currentDate": bson.M{"updatedAt": true},
	})
	return err
}
