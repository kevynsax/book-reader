package sentences

import "testing"

func TestMinSentenceLen(t *testing.T) {
	got := ReflowSentences("1. Canguru e Elefante na savana africana durante a tarde. Depois veio a noite longa e fria de inverno.")
	want := "1. Canguru e Elefante na savana africana durante a tarde.\nDepois veio a noite longa e fria de inverno."
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}
