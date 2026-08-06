package tts

import (
	"regexp"
	"strings"
)

// Display names for voices. The TTS servers each ship their own alias table,
// so a name used to depend on which server answered the probe first — the
// fleet runs mixed builds and disagreed. book-reader owns the mapping instead,
// so a voice reads the same in the render chip, the voice picker and the
// chapter cards.
var voiceAliases = map[string]map[string]string{
	"chatterbox": {
		"default":                         "Oliver",
		"en-GB-RyanNeural":                "Arthur",
		"en-GB-SoniaNeural":               "Eleanor",
		"en-US-AndrewNeural":              "Samuel",
		"en-US-AvaNeural":                 "Rachel",
		"en-US-BrianNeural":               "Henry",
		"en-US-EmmaNeural":                "Ruth",
		"pt-BR-AntonioNeural":             "Mateus",
		"pt-BR-FranciscaNeural":           "Helena",
		"pt-BR-ThalitaMultilingualNeural": "Beatriz",
		"pt-PT-DuarteNeural":              "Tomás",
		"pt-PT-RaquelNeural":              "Inês",
	},
	"openaudio": {
		"default":                         "Theodore",
		"en-GB-RyanNeural":                "Edward",
		"en-GB-SoniaNeural":               "Charlotte",
		"en-US-AndrewNeural":              "Nathan",
		"en-US-AvaNeural":                 "Grace",
		"en-US-BrianNeural":               "Walter",
		"en-US-EmmaNeural":                "Naomi",
		"pt-BR-AntonioNeural":             "Mateus",
		"pt-BR-FranciscaNeural":           "Larissa",
		"pt-BR-ThalitaMultilingualNeural": "Camila",
		"pt-PT-DuarteNeural":              "Gonçalo",
		"pt-PT-RaquelNeural":              "Matilde",
	},
	"higgs": {
		"default":                         "Julian",
		"en-GB-RyanNeural":                "Sebastian",
		"en-GB-SoniaNeural":               "Imogen",
		"en-US-AndrewNeural":              "Caleb",
		"en-US-AvaNeural":                 "Vivian",
		"en-US-BrianNeural":               "Gordon",
		"en-US-EmmaNeural":                "Hazel",
		"pt-BR-AntonioNeural":             "Bruno",
		"pt-BR-FranciscaNeural":           "Renata",
		"pt-BR-ThalitaMultilingualNeural": "Bianca",
		"pt-PT-DuarteNeural":              "Afonso",
		"pt-PT-RaquelNeural":              "Carolina",
	},
	"orpheus": {
		"tara": "Sophie", "leah": "Diana", "jess": "Megan", "leo": "Marcus",
		"dan": "Victor", "mia": "Paula", "zac": "Derek", "zoe": "Tessa",
	},
	"kokoro": {
		"af_heart": "Hannah", "af_bella": "Bella", "af_nicole": "Nicole",
		"af_sarah": "Sarah", "af_sky": "Skyler", "af_alloy": "Allison",
		"af_aoede": "Audrey", "af_jessica": "Jessica", "af_kore": "Cora",
		"af_nova": "Nora", "af_river": "Riley",
		"am_adam": "Adam", "am_michael": "Michael", "am_echo": "Elliot",
		"am_eric": "Eric", "am_fenrir": "Fenton", "am_liam": "Liam",
		"am_onyx": "Owen", "am_puck": "Parker", "am_santa": "Nicholas",
		"bf_emma": "Emily", "bf_alice": "Alice", "bf_isabella": "Isabella",
		"bf_lily": "Lily", "bm_daniel": "Daniel", "bm_george": "George",
		"bm_lewis": "Lewis", "bm_fable": "Felix",
		"pf_dora": "Dora", "pm_alex": "Alex", "pm_santa": "Papai Noel",
	},
}

var (
	azureNameRe  = regexp.MustCompile(`^[a-z]{2}-[A-Z]{2}-(.+?)(?:Multilingual)?Neural$`)
	kokoroNameRe = regexp.MustCompile(`^[a-z]{2}_(.+)$`)
)

// VoiceDisplayName is the human name for a bare voice id under a model,
// falling back to a readable form of the id itself.
func VoiceDisplayName(modelID, voice string) string {
	if name, ok := voiceAliases[modelID][voice]; ok {
		return name
	}
	if m := azureNameRe.FindStringSubmatch(voice); m != nil {
		return m[1]
	}
	if m := kokoroNameRe.FindStringSubmatch(voice); m != nil {
		parts := strings.Split(m[1], "_")
		for i, p := range parts {
			if p != "" {
				parts[i] = strings.ToUpper(p[:1]) + p[1:]
			}
		}
		return strings.Join(parts, " ")
	}
	if voice == "" {
		return ""
	}
	return strings.ToUpper(voice[:1]) + voice[1:]
}

// VoiceDisplayNames maps every voice id to its display name for a model.
func VoiceDisplayNames(modelID string, voices []string) map[string]string {
	names := make(map[string]string, len(voices))
	for _, v := range voices {
		names[v] = VoiceDisplayName(modelID, v)
	}
	return names
}
