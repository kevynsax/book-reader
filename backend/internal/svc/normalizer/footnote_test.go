package normalizer

import (
	"context"
	"strings"
	"testing"
)

func TestFootnoteMarksDropped(t *testing.T) {
	got := NormalizeForSpeech(context.Background(), "Ele levou o assunto mais a sério.[1] Depois voltou.[12]", "pt")
	if strings.Contains(got, "[") || strings.Contains(got, "]") || strings.Contains(got, "um") && strings.Contains(got, "[um]") {
		t.Fatalf("footnote marks survived: %q", got)
	}
	if !strings.Contains(got, "a sério. Depois voltou.") {
		t.Fatalf("unexpected spacing: %q", got)
	}
}
