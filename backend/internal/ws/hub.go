package ws

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Envelope is the wire protocol: text frames carrying {event, data} both ways.
type Envelope struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

// Emitter is what routes and workers get instead of Node's `io` instance.
type Emitter interface {
	Emit(event string, data any)
}

type client struct {
	conn *websocket.Conn
	send chan []byte
}

// SubscribeHandler serves a client→server event; replies go only to that
// client via the reply func.
type SubscribeHandler func(ctx context.Context, data json.RawMessage, reply func(event string, data any))

type Hub struct {
	mu       sync.Mutex
	clients  map[*client]struct{}
	handlers map[string]SubscribeHandler
	origins  []string
}

func NewHub(origins []string) *Hub {
	return &Hub{
		clients:  map[*client]struct{}{},
		handlers: map[string]SubscribeHandler{},
		origins:  origins,
	}
}

func (h *Hub) Handle(event string, fn SubscribeHandler) {
	h.handlers[event] = fn
}

// Emit broadcasts an event to every connected client (Node used global
// io.emit — no rooms).
func (h *Hub) Emit(event string, data any) {
	payload, err := json.Marshal(map[string]any{"event": event, "data": data})
	if err != nil {
		log.Printf("ws: marshal %s: %v", event, err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.send <- payload:
		default:
			// Slow consumer: drop the client; its read loop will clean up.
			close(c.send)
			delete(h.clients, c)
		}
	}
}

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: h.origins,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(1 << 20)

	c := &client{conn: conn, send: make(chan []byte, 64)}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	log.Printf("ws: client connected (%d online)", h.count())

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go h.writePump(ctx, c)
	h.readPump(ctx, c)

	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		close(c.send)
		delete(h.clients, c)
	}
	h.mu.Unlock()
	conn.Close(websocket.StatusNormalClosure, "")
	log.Printf("ws: client disconnected (%d online)", h.count())
}

func (h *Hub) count() int {
	return len(h.clients)
}

func (h *Hub) writePump(ctx context.Context, c *client) {
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-c.send:
			if !ok {
				c.conn.Close(websocket.StatusPolicyViolation, "send queue overflow")
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.conn.Write(writeCtx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return
			}
		case <-ping.C:
			pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

func (h *Hub) readPump(ctx context.Context, c *client) {
	for {
		_, msg, err := c.conn.Read(ctx)
		if err != nil {
			return
		}
		var env Envelope
		if err := json.Unmarshal(msg, &env); err != nil {
			continue
		}
		fn, ok := h.handlers[env.Event]
		if !ok {
			continue
		}
		reply := func(event string, data any) {
			payload, err := json.Marshal(map[string]any{"event": event, "data": data})
			if err != nil {
				return
			}
			h.mu.Lock()
			if _, alive := h.clients[c]; alive {
				select {
				case c.send <- payload:
				default:
				}
			}
			h.mu.Unlock()
		}
		go fn(ctx, env.Data, reply)
	}
}
