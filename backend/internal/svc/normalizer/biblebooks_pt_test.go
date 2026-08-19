package normalizer

import (
	"context"
	"strings"
	"testing"
)

func TestExAbbrev(t *testing.T) {
	cases := map[string]string{
		"pede ele (Êx 33.18).":       "êxodo capítulo trinta e três versículo dezoito",
		"o Deus de Jacó” (Êx 3.6).":  "êxodo capítulo três versículo seis",
		"enviou a vocês’” (Êx 3.14, NVI).": "êxodo capítulo três versículo catorze",
		"geração. (Êx 34.6-7)":       "êxodo capítulo trinta e quatro versículos seis e sete",
		"ÊXODO 3.14":                 "êxodo capítulo três versículo catorze",
	}
	for in, want := range cases {
		got := NormalizeForSpeech(context.Background(), in, "pt")
		if !strings.Contains(got, want) {
			t.Errorf("%q -> %q, want it to contain %q", in, got, want)
		}
	}
}
