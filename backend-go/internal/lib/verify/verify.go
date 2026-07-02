// Package verify compares what a TTS segment was asked to say against what
// Whisper heard. Whisper drops punctuation, lowercases, and normalizes
// spacing/diacritics, so the match is fuzzy: both sides are normalized to
// word tokens and scored by word-level edit distance.
package verify

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// NormalizeWords lowercases, strips combining diacritics (U+0300–U+036F, the
// same block Node strips), drops punctuation/symbols, and splits into word
// tokens. Digits are kept as-is.
func NormalizeWords(text string) []string {
	decomposed := norm.NFKD.String(text)
	var b strings.Builder
	b.Grow(len(decomposed))
	for _, r := range decomposed {
		switch {
		case r >= 0x0300 && r <= 0x036F:
			// combining mark — dropped
		case unicode.IsLetter(r) || unicode.IsNumber(r) || unicode.IsSpace(r):
			b.WriteRune(unicode.ToLower(r))
		default:
			b.WriteRune(' ')
		}
	}
	return strings.Fields(b.String())
}

func wordEditDistance(a, b []string) int {
	if len(a) == 0 {
		return len(b)
	}
	if len(b) == 0 {
		return len(a)
	}
	prev := make([]int, len(b)+1)
	curr := make([]int, len(b)+1)
	for i := range prev {
		prev[i] = i
	}
	for i := 1; i <= len(a); i++ {
		curr[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			curr[j] = min(prev[j]+1, curr[j-1]+1, prev[j-1]+cost)
		}
		prev, curr = curr, prev
	}
	return prev[len(b)]
}

// WordSimilarity is word-level similarity in [0, 1]:
// 1 - editDistance/longerLength. Two empty strings are a perfect match; one
// empty against a non-empty counts as 0.
func WordSimilarity(expected, actual string) float64 {
	a := NormalizeWords(expected)
	b := NormalizeWords(actual)
	if len(a) == 0 && len(b) == 0 {
		return 1
	}
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	dist := wordEditDistance(a, b)
	return 1 - float64(dist)/float64(max(len(a), len(b)))
}
