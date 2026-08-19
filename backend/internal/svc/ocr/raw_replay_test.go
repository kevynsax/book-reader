package ocr

import (
	"os"
	"strings"
	"testing"
)

func TestParseOcrRawReplay(t *testing.T) {
	path := os.Getenv("OCR_RAW_FILE")
	if path == "" {
		t.Skip("no OCR_RAW_FILE")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	res := parseOcrResult(string(raw))
	t.Logf("language=%q", res.Language)
	tail := res.Content
	if len(tail) > 260 {
		tail = tail[len(tail)-260:]
	}
	t.Logf("content tail: %q", tail)
	for _, bad := range []string{`"}`, `}}`, `\"`, "```"} {
		if strings.Contains(res.Content, bad) {
			t.Errorf("artifact %q survived in content", bad)
		}
	}
}
