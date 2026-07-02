package tts

import "regexp"

// Model is a selectable TTS model. All servers speak the same OpenAI audio
// shape and expose this catalog via /v1/models; here we keep the per-model
// metadata the app needs. The composite voice id stored on a book is
// "model:voice".
type Model struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	UsesLanguage   bool     `json:"-"`
	Named          bool     `json:"-"`
	FallbackVoices []string `json:"-"`
}

// Curated Chatterbox/Fish clone voices (the mp3 clips in tts-2/voices/).
var cloneVoices = []string{
	"pt-BR-FranciscaNeural", "pt-BR-AntonioNeural", "pt-BR-ThalitaMultilingualNeural",
	"pt-PT-RaquelNeural", "pt-PT-DuarteNeural",
	"en-US-AvaNeural", "en-US-AndrewNeural", "en-US-EmmaNeural", "en-US-BrianNeural",
	"en-GB-SoniaNeural", "en-GB-RyanNeural",
}

// Kokoro's named voices (af_/pf_ … prefixes encode language + gender).
var kokoroVoices = []string{
	"af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_nicole", "af_nova", "af_sarah", "af_sky",
	"am_adam", "am_echo", "am_eric", "am_liam", "am_michael", "am_onyx", "am_puck",
	"bf_alice", "bf_emma", "bf_lily", "bm_daniel", "bm_george", "bm_lewis",
	"pf_dora", "pm_alex", "pm_santa",
}

// Models is ordered: the first entry is the default model.
var Models = []Model{
	{ID: "chatterbox", Label: "Chatterbox", UsesLanguage: true, Named: false, FallbackVoices: cloneVoices},
	{ID: "openaudio", Label: "OpenAudio (Fish)", UsesLanguage: true, Named: false, FallbackVoices: cloneVoices},
	{ID: "kokoro", Label: "Kokoro", UsesLanguage: true, Named: true, FallbackVoices: kokoroVoices},
}

func GetModel(id string) (Model, bool) {
	for _, m := range Models {
		if m.ID == id {
			return m, true
		}
	}
	return Model{}, false
}

// ClonedVoiceModel wraps a model id a server advertises but the static catalog
// doesn't know about, treated as a cloned-voice backend.
func ClonedVoiceModel(id string) Model {
	return Model{ID: id, Label: id, UsesLanguage: true, Named: false, FallbackVoices: []string{}}
}

func ResolveModel(id string) Model {
	if m, ok := GetModel(id); ok {
		return m
	}
	return ClonedVoiceModel(id)
}

var (
	azureVoiceRe  = regexp.MustCompile(`^[a-z]{2}-[A-Z]{2}-`)
	kokoroVoiceRe = regexp.MustCompile(`^[a-z]{2}_`)
)

// inferModel routes a legacy, unprefixed voice id to its model.
func inferModel(voice string) Model {
	if voice == "default" || azureVoiceRe.MatchString(voice) {
		m, _ := GetModel("chatterbox")
		return m
	}
	if kokoroVoiceRe.MatchString(voice) {
		m, _ := GetModel("kokoro")
		return m
	}
	return Models[0]
}

// ParseVoice splits a composite "model:voice" id into its model + bare voice.
// Legacy unprefixed ids are routed by inference (no DB migration needed).
func ParseVoice(composite string) (Model, string) {
	for i := 0; i < len(composite); i++ {
		if composite[i] == ':' {
			if i == 0 {
				break
			}
			return ResolveModel(composite[:i]), composite[i+1:]
		}
	}
	return inferModel(composite), composite
}
