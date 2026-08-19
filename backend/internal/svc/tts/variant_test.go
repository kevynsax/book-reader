package tts

import "testing"

func TestAssembleVariantKey(t *testing.T) {
	cases := map[string]AssembleVariant{
		"":   {},
		"t":  {AltTitle: true},
		"q":  {AltQuote: true},
		"tq": {AltTitle: true, AltQuote: true},
	}
	for want, v := range cases {
		if got := v.Key(); got != want {
			t.Errorf("Key() = %q, want %q", got, want)
		}
	}
}

func TestVariantPickFile(t *testing.T) {
	title := SegmentInput{AudioPath: "p", AltAudioPath: "a", IsTitle: true}
	quote := SegmentInput{AudioPath: "p", AltAudioPath: "a", Quote: true}
	quoteNoAlt := SegmentInput{AudioPath: "p", Quote: true}
	narration := SegmentInput{AudioPath: "p", AltAudioPath: "a"}
	cases := []struct {
		name string
		v    AssembleVariant
		seg  SegmentInput
		want string
	}{
		{"default keeps plain title", AssembleVariant{}, title, "p"},
		{"default keeps plain quote", AssembleVariant{}, quote, "p"},
		{"alt-title picks title alt", AssembleVariant{AltTitle: true}, title, "a"},
		{"alt-title ignores quotes", AssembleVariant{AltTitle: true}, quote, "p"},
		{"alt-quote picks quote alt", AssembleVariant{AltQuote: true}, quote, "a"},
		{"missing alt falls back", AssembleVariant{AltQuote: true}, quoteNoAlt, "p"},
		{"narration never swaps", AssembleVariant{AltTitle: true, AltQuote: true}, narration, "p"},
	}
	for _, c := range cases {
		if got := c.v.pickFile(c.seg); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
