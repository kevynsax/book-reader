package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/kevynsax/book-reader/backend/internal/svc/normalizer"
)

type row struct {
	ID      string `json:"id"`
	Ch      int    `json:"ch"`
	Display string `json:"display"`
	Text    string `json:"text,omitempty"`
}

func main() {
	lang := "pt"
	if len(os.Args) > 1 {
		lang = os.Args[1]
	}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1024*1024), 1024*1024)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	for in.Scan() {
		var r row
		if err := json.Unmarshal(in.Bytes(), &r); err != nil {
			fmt.Fprintln(os.Stderr, "bad line:", err)
			os.Exit(1)
		}
		r.Text = normalizer.NormalizeForSpeech(context.Background(), r.Display, lang)
		b, _ := json.Marshal(r)
		out.Write(b)
		out.WriteByte('\n')
	}
}
