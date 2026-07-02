package store

import (
	"context"
	"strings"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type Store struct {
	Client   *mongo.Client
	DB       *mongo.Database
	Books    *Books
	Lexicons *Lexicons
}

// dbNameFromURI extracts the database path segment from a MongoDB URI,
// defaulting to "book-reader" (mongoose derives the DB the same way).
func dbNameFromURI(uri string) string {
	rest := uri
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	if i := strings.Index(rest, "/"); i >= 0 {
		rest = rest[i+1:]
		if j := strings.IndexAny(rest, "?"); j >= 0 {
			rest = rest[:j]
		}
		if rest != "" {
			return rest
		}
	}
	return "book-reader"
}

func Connect(ctx context.Context, uri string) (*Store, error) {
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		return nil, err
	}
	if err := client.Ping(ctx, nil); err != nil {
		return nil, err
	}
	db := client.Database(dbNameFromURI(uri))
	return &Store{
		Client:   client,
		DB:       db,
		Books:    &Books{col: db.Collection("books")},
		Lexicons: &Lexicons{col: db.Collection("lexicons")},
	}, nil
}
