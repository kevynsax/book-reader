package model

import "testing"

func TestSynthVoiceForPrecedence(t *testing.T) {
	roles := map[string]RoleVoices{
		"kokoro:pm_alex": {RoleQuoteFemale: "kokoro:pf_dora", RoleTitle: "kokoro:pm_santa"},
	}
	cases := []struct {
		name  string
		sen   Sentence
		voice string
		alt   bool
		want  string
	}{
		{"narration plain", Sentence{}, "kokoro:pm_alex", false, "kokoro:pm_alex"},
		{"narration alt", Sentence{}, "kokoro:pm_alex", true, "kokoro:pm_alex"},
		{"role plain take stays narrator", Sentence{Role: RoleQuoteFemale}, "kokoro:pm_alex", false, "kokoro:pm_alex"},
		{"role alt take uses role voice", Sentence{Role: RoleQuoteFemale}, "kokoro:pm_alex", true, "kokoro:pf_dora"},
		{"title alt", Sentence{Role: RoleTitle}, "kokoro:pm_alex", true, "kokoro:pm_santa"},
		{"unconfigured role falls back", Sentence{Role: RoleQuoteMale}, "kokoro:pm_alex", true, "kokoro:pm_alex"},
		{"unconfigured track falls back", Sentence{Role: RoleQuoteFemale}, "higgs:pt-BR-AntonioNeural", true, "higgs:pt-BR-AntonioNeural"},
		{"explicit override beats role", Sentence{Role: RoleQuoteFemale, VoiceOverrides: map[string]string{"kokoro:pm_alex": "higgs:x"}}, "kokoro:pm_alex", true, "higgs:x"},
		{"explicit override applies to plain take too", Sentence{Role: RoleQuoteFemale, VoiceOverrides: map[string]string{"kokoro:pm_alex": "higgs:x"}}, "kokoro:pm_alex", false, "higgs:x"},
		{"all-voices override beats role", Sentence{Role: RoleQuoteFemale, VoiceOverrides: map[string]string{AllVoices: "higgs:y"}}, "kokoro:pm_alex", true, "higgs:y"},
	}
	for _, c := range cases {
		if got := c.sen.SynthVoiceFor(c.voice, roles, c.alt); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestSynthVoiceWrapper(t *testing.T) {
	s := Sentence{VoiceOverrides: map[string]string{AllVoices: "v"}}
	if got := s.SynthVoice("track"); got != "v" {
		t.Errorf("SynthVoice = %q, want v", got)
	}
}
