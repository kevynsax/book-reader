// paritydiff compares the Node backend (:3001) and Go backend (:3002)
// responses over the same MongoDB: plain-JSON HTTP endpoints plus the
// books:sync payload (socket.io on Node, /ws JSON envelope on Go).
//
// Usage: go run ./tools/paritydiff [-node http://localhost:3001] [-go http://localhost:3002]
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/coder/websocket"
)

var (
	nodeURL = flag.String("node", "http://localhost:3001", "Node backend base URL")
	goURL   = flag.String("go", "http://localhost:3002", "Go backend base URL")
)

func main() {
	flag.Parse()
	failures := 0

	paths := []string{
		"/health",
		"/api/models",
		"/api/lexicon",
		"/api/books/can-delete",
	}

	nodeBooks := fetchBooksSyncNode(*nodeURL)
	goBooks := fetchBooksSyncGo(*goURL)
	failures += compare("books:sync", nodeBooks, goBooks)

	// Per-book sentence endpoints for every chapter with sentences.
	for _, b := range asArray(nodeBooks) {
		book, _ := b.(map[string]any)
		if book == nil {
			continue
		}
		id, _ := book["_id"].(string)
		chapters, _ := book["chapters"].([]any)
		for idx := range chapters {
			paths = append(paths, fmt.Sprintf("/api/books/%s/chapters/%d/sentences", id, idx))
		}
	}

	for _, p := range paths {
		a, aCode := get(*nodeURL + p)
		b, bCode := get(*goURL + p)
		if aCode != bCode {
			fmt.Printf("FAIL %s: status %d vs %d\n", p, aCode, bCode)
			failures++
			continue
		}
		failures += compare(p, a, b)
	}

	if failures == 0 {
		fmt.Println("PARITY OK")
		return
	}
	fmt.Printf("%d difference group(s)\n", failures)
	os.Exit(1)
}

func get(url string) (any, int) {
	res, err := http.Get(url)
	if err != nil {
		return fmt.Sprintf("request error: %v", err), 0
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return string(body), res.StatusCode
	}
	return v, res.StatusCode
}

func asArray(v any) []any {
	arr, _ := v.([]any)
	return arr
}

func compare(label string, a, b any) int {
	diffs := diffValues("", a, b)
	if len(diffs) == 0 {
		fmt.Printf("ok   %s\n", label)
		return 0
	}
	fmt.Printf("FAIL %s:\n", label)
	for i, d := range diffs {
		if i >= 20 {
			fmt.Printf("  … and %d more\n", len(diffs)-i)
			break
		}
		fmt.Printf("  %s\n", d)
	}
	return 1
}

func diffValues(path string, a, b any) []string {
	var diffs []string
	switch av := a.(type) {
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok {
			return []string{fmt.Sprintf("%s: object vs %T", path, b)}
		}
		keys := map[string]bool{}
		for k := range av {
			keys[k] = true
		}
		for k := range bv {
			keys[k] = true
		}
		sorted := make([]string, 0, len(keys))
		for k := range keys {
			sorted = append(sorted, k)
		}
		sort.Strings(sorted)
		for _, k := range sorted {
			ava, inA := av[k]
			bva, inB := bv[k]
			p := path + "." + k
			switch {
			case !inA:
				diffs = append(diffs, fmt.Sprintf("%s: only in Go (%v)", p, brief(bva)))
			case !inB:
				diffs = append(diffs, fmt.Sprintf("%s: only in Node (%v)", p, brief(ava)))
			default:
				diffs = append(diffs, diffValues(p, ava, bva)...)
			}
		}
	case []any:
		bv, ok := b.([]any)
		if !ok {
			return []string{fmt.Sprintf("%s: array vs %T", path, b)}
		}
		if len(av) != len(bv) {
			return []string{fmt.Sprintf("%s: array length %d vs %d", path, len(av), len(bv))}
		}
		for i := range av {
			diffs = append(diffs, diffValues(fmt.Sprintf("%s[%d]", path, i), av[i], bv[i])...)
		}
	default:
		if fmt.Sprintf("%v", a) != fmt.Sprintf("%v", b) {
			diffs = append(diffs, fmt.Sprintf("%s: %v vs %v", path, brief(a), brief(b)))
		}
	}
	return diffs
}

func brief(v any) string {
	s := fmt.Sprintf("%v", v)
	if len(s) > 80 {
		return s[:80] + "…"
	}
	return s
}

// fetchBooksSyncGo speaks the Go backend's /ws JSON envelope.
func fetchBooksSyncGo(base string) any {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	wsBase := "ws" + strings.TrimPrefix(base, "http")
	conn, _, err := websocket.Dial(ctx, wsBase+"/ws", nil)
	if err != nil {
		return fmt.Sprintf("go ws error: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	conn.SetReadLimit(64 << 20)

	sub, _ := json.Marshal(map[string]any{"event": "subscribe-to-books", "data": map[string]any{}})
	if err := conn.Write(ctx, websocket.MessageText, sub); err != nil {
		return fmt.Sprintf("go ws write error: %v", err)
	}
	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			return fmt.Sprintf("go ws read error: %v", err)
		}
		var env struct {
			Event string          `json:"event"`
			Data  json.RawMessage `json:"data"`
		}
		if json.Unmarshal(msg, &env) == nil && env.Event == "books:sync" {
			var v any
			_ = json.Unmarshal(env.Data, &v)
			return v
		}
	}
}

// fetchBooksSyncNode speaks just enough Engine.IO v4 + Socket.IO v4 over a
// raw websocket to receive one books:sync payload from the Node backend.
func fetchBooksSyncNode(base string) any {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	wsBase := "ws" + strings.TrimPrefix(base, "http")
	conn, _, err := websocket.Dial(ctx, wsBase+"/socket.io/?EIO=4&transport=websocket", nil)
	if err != nil {
		return fmt.Sprintf("node ws error: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	conn.SetReadLimit(64 << 20)

	read := func() (string, error) {
		_, msg, err := conn.Read(ctx)
		return string(msg), err
	}

	// Engine.IO open packet ("0{...}") arrives first; then join the default
	// namespace ("40") and wait for the ack ("40{...}").
	if _, err := read(); err != nil {
		return fmt.Sprintf("node ws open error: %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte("40")); err != nil {
		return fmt.Sprintf("node ws connect error: %v", err)
	}
	for {
		msg, err := read()
		if err != nil {
			return fmt.Sprintf("node ws read error: %v", err)
		}
		if strings.HasPrefix(msg, "40") {
			break
		}
		if msg == "2" { // engine.io ping → pong
			_ = conn.Write(ctx, websocket.MessageText, []byte("3"))
		}
	}

	sub, _ := json.Marshal([]any{"subscribe-to-books", map[string]any{}})
	if err := conn.Write(ctx, websocket.MessageText, append([]byte("42"), sub...)); err != nil {
		return fmt.Sprintf("node ws emit error: %v", err)
	}
	for {
		msg, err := read()
		if err != nil {
			return fmt.Sprintf("node ws read error: %v", err)
		}
		if msg == "2" {
			_ = conn.Write(ctx, websocket.MessageText, []byte("3"))
			continue
		}
		if strings.HasPrefix(msg, "42") {
			var packet []json.RawMessage
			if json.Unmarshal([]byte(msg[2:]), &packet) == nil && len(packet) == 2 {
				var event string
				_ = json.Unmarshal(packet[0], &event)
				if event == "books:sync" {
					var v any
					_ = json.Unmarshal(packet[1], &v)
					return v
				}
			}
		}
	}
}
