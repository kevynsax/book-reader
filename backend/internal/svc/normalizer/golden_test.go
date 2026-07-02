package normalizer

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/kevynsax/book-reader/backend/internal/data/numberwords"
	"github.com/kevynsax/book-reader/backend/internal/lib/sanitize"
	"github.com/kevynsax/book-reader/backend/internal/lib/sentences"
	"github.com/kevynsax/book-reader/backend/internal/lib/verify"
)

type fixtures struct {
	Normalize []struct {
		Lang, Text, Want string
	} `json:"normalize"`
	Reflow []struct {
		Text, Want string
	} `json:"reflow"`
	IsTitle []struct {
		Text string
		Want bool
	} `json:"isTitle"`
	Similarity []struct {
		A, B  string
		Want  float64
		Words []string
	} `json:"similarity"`
	Sanitize []struct {
		Text, Want string
	} `json:"sanitize"`
	Numbers []struct {
		Lang  string
		N     int64
		Words string
	} `json:"numbers"`
}

func loadFixtures(t *testing.T) fixtures {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "fixtures.json"))
	if err != nil {
		t.Skipf("fixtures not generated: %v", err)
	}
	var f fixtures
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestGoldenNormalize(t *testing.T) {
	f := loadFixtures(t)
	ctx := context.Background()
	for _, c := range f.Normalize {
		if got := NormalizeForSpeech(ctx, c.Text, c.Lang); got != c.Want {
			t.Errorf("normalize(%q, %s):\n  node: %q\n  go:   %q", c.Text, c.Lang, c.Want, got)
		}
	}
}

func TestGoldenReflow(t *testing.T) {
	f := loadFixtures(t)
	for _, c := range f.Reflow {
		if got := sentences.ReflowSentences(c.Text); got != c.Want {
			t.Errorf("reflow(%q):\n  node: %q\n  go:   %q", c.Text, c.Want, got)
		}
	}
}

func TestGoldenIsTitle(t *testing.T) {
	f := loadFixtures(t)
	for _, c := range f.IsTitle {
		if got := sentences.IsTitle(c.Text, 5); got != c.Want {
			t.Errorf("isTitle(%q): node %v, go %v", c.Text, c.Want, got)
		}
	}
}

func TestGoldenSimilarity(t *testing.T) {
	f := loadFixtures(t)
	for _, c := range f.Similarity {
		got := verify.WordSimilarity(c.A, c.B)
		if math.Abs(got-c.Want) > 1e-9 {
			t.Errorf("similarity(%q, %q): node %v, go %v", c.A, c.B, c.Want, got)
		}
		words := verify.NormalizeWords(c.A)
		if len(words) != len(c.Words) {
			t.Errorf("normalizeWords(%q): node %v, go %v", c.A, c.Words, words)
			continue
		}
		for i := range words {
			if words[i] != c.Words[i] {
				t.Errorf("normalizeWords(%q): node %v, go %v", c.A, c.Words, words)
				break
			}
		}
	}
}

func TestGoldenSanitize(t *testing.T) {
	f := loadFixtures(t)
	for _, c := range f.Sanitize {
		if got := sanitize.PageText(c.Text); got != c.Want {
			t.Errorf("sanitize(%q):\n  node: %q\n  go:   %q", c.Text, c.Want, got)
		}
	}
}

func TestGoldenNumbers(t *testing.T) {
	f := loadFixtures(t)
	for _, c := range f.Numbers {
		if got := numberwords.NumberToWords(c.N, c.Lang); got != c.Words {
			t.Errorf("numberToWords(%d, %s): node %q, go %q", c.N, c.Lang, c.Words, got)
		}
	}
}
