package tts

import "testing"

func TestValidSplitPieces(t *testing.T) {
	cases := []struct {
		name    string
		display string
		parts   []string
		want    bool
	}{
		{
			"faithful split",
			"But God spared him, so now Paul is sending him back with this letter",
			[]string{"But God spared him, so now Paul is sending him back", "with this letter"},
			true,
		},
		{
			"slm refusal hallucination",
			"In exodus seven through ten,",
			[]string{"In exodus seven through ten,", "(No further text provided to complete the sentence.)"},
			false,
		},
		{
			"unspeakable fragment piece",
			"The Scene(s)",
			[]string{"The Scene", "(s)"},
			false,
		},
		{
			"invented footnote piece",
			"King James Version New American Standard Bible RSV New International Version NAB GNB JB NEB LB",
			[]string{"King James Version New American Standard Bible RSV New International Version NAB GNB JB NEB LB", "two."},
			false,
		},
		{
			"punctuation-only adjustments",
			"chapter two verse seven, twelve–fourteen, nineteen,",
			[]string{"chapter two verse seven,", "twelve–fourteen, nineteen,"},
			true,
		},
	}
	for _, c := range cases {
		if got := validSplitPieces(c.display, c.parts); got != c.want {
			t.Errorf("%s: validSplitPieces = %v, want %v", c.name, got, c.want)
		}
	}
}
