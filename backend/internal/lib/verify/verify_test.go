package verify

import "testing"

func TestWordSimilarityLangDigits(t *testing.T) {
	cases := []struct {
		expected, actual, lang string
		min                    float64
	}{
		{"seven hundred seventy seven", "777.", "en", 1},
		{"Eerdmans, one thousand nine hundred ninety five", "Eerdmans, 1995", "en", 1},
		{"capítulo três versículo doze", "capítulo 3 versículo 12", "pt-BR", 1},
		{"Matthew chapter nineteen verse twenty three", "Matthew 19:23", "en", 0.5},
	}
	for _, c := range cases {
		got := WordSimilarityLang(c.expected, c.actual, c.lang)
		if got < c.min {
			t.Errorf("WordSimilarityLang(%q, %q, %q) = %.2f, want >= %.2f", c.expected, c.actual, c.lang, got, c.min)
		}
	}
	if got := WordSimilarityLang("seven hundred seventy seven", "totally different words", "en"); got > 0.3 {
		t.Errorf("mismatched text scored %.2f, want low", got)
	}
}
