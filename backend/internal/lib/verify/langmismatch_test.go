package verify

import "testing"

func TestTranscriptLanguageMismatch(t *testing.T) {
	cases := []struct {
		expected, transcript string
		want                 bool
	}{
		{"O garoto foi embora satisfeito, confiando em seu pai; para o momento, aquilo fazia sentido.",
			"The kid was satisfied, confiding in his father. For the moment, it was a sense.", true},
		{"O garoto foi embora satisfeito, confiando em seu pai.",
			"O garoto foi embora satisfeito confiando em seu pai", false},
		{"Disse que era um modelo do mundo.", "He said he was a model of the world.", true},
		{"Êxodo capítulo três versículo catorze", "Êxodo capítulo 3 versículo 14", false},
		{"CAMELO, CANGURU E ELEFANTE", "Camelo, canguro e elefante.", false},
	}
	for _, c := range cases {
		if got := TranscriptLanguageMismatch(c.expected, c.transcript); got != c.want {
			t.Errorf("TranscriptLanguageMismatch(%q, %q) = %v, want %v", c.expected, c.transcript, got, c.want)
		}
	}
}
