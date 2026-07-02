package ws

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/kevynsax/book-reader/backend-go/internal/model"
	"github.com/kevynsax/book-reader/backend-go/internal/store"
)

// RegisterBookSync attaches the two client→server subscriptions (port of
// registerBookSync in routes/books.ts).
func RegisterBookSync(hub *Hub, st *store.Store) {
	hub.Handle("subscribe-to-books", func(ctx context.Context, data json.RawMessage, reply func(string, any)) {
		var payload struct {
			LastUpdate string `json:"lastUpdate"`
		}
		_ = json.Unmarshal(data, &payload)

		filter := bson.M{"deleted": bson.M{"$ne": true}}
		if payload.LastUpdate != "" {
			if since, err := time.Parse(time.RFC3339, payload.LastUpdate); err == nil {
				filter["updatedAt"] = bson.M{"$gt": since}
			}
		}
		books, err := st.Books.Find(ctx, filter, bson.D{{Key: "createdAt", Value: -1}})
		if err != nil {
			log.Printf("ws: subscribe-to-books: %v", err)
			return
		}
		sanitized := make([]model.ClientBook, len(books))
		for i, b := range books {
			sanitized[i] = model.SanitizeBook(b)
		}
		reply("books:sync", sanitized)
	})

	hub.Handle("subscribe-to-book", func(ctx context.Context, data json.RawMessage, reply func(string, any)) {
		var payload struct {
			BookID string `json:"bookId"`
		}
		_ = json.Unmarshal(data, &payload)
		if payload.BookID == "" {
			return
		}
		book, err := st.Books.FindByID(ctx, payload.BookID)
		if err != nil || book == nil || book.Deleted {
			return
		}
		reply("books:sync", []model.ClientBook{model.SanitizeBook(book)})
	})
}
