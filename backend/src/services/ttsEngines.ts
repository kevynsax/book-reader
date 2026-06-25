// A selectable TTS model. All servers speak the same OpenAI audio shape and
// expose this catalog via /v1/models; here we keep the per-model metadata the
// app needs (language handling + a fallback voice list when a server can't be
// reached). The composite voice id stored on a book is "model:voice".

export interface TtsModel {
  id: string;            // catalog key sent as `model` (chatterbox, kokoro, openaudio)
  label: string;
  usesLanguage: boolean; // forward the per-chapter language as lang_code?
  named: boolean;        // built-in named voices (Kokoro) vs cloned clips
  fallbackVoices: string[]; // used if a server's /v1/audio/voices is unreachable
}

// Curated Chatterbox/Fish clone voices (the mp3 clips in tts-2/voices/).
const CLONE_VOICES = [
  'pt-BR-FranciscaNeural', 'pt-BR-AntonioNeural', 'pt-BR-ThalitaMultilingualNeural',
  'pt-PT-RaquelNeural', 'pt-PT-DuarteNeural',
  'en-US-AvaNeural', 'en-US-AndrewNeural', 'en-US-EmmaNeural', 'en-US-BrianNeural',
  'en-GB-SoniaNeural', 'en-GB-RyanNeural',
];

// Kokoro's named voices (af_/pf_ … prefixes encode language + gender).
const KOKORO_VOICES = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_nicole', 'af_nova', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_liam', 'am_michael', 'am_onyx', 'am_puck',
  'bf_alice', 'bf_emma', 'bf_lily', 'bm_daniel', 'bm_george', 'bm_lewis',
  'pf_dora', 'pm_alex', 'pm_santa',
];

// Order matters: the first entry is the default model.
export const MODELS: TtsModel[] = [
  { id: 'chatterbox', label: 'Chatterbox', usesLanguage: true, named: false, fallbackVoices: CLONE_VOICES },
  { id: 'openaudio', label: 'OpenAudio (Fish)', usesLanguage: true, named: false, fallbackVoices: CLONE_VOICES },
  { id: 'kokoro', label: 'Kokoro', usesLanguage: true, named: true, fallbackVoices: KOKORO_VOICES },
];

export function getModel(id: string): TtsModel | undefined {
  return MODELS.find(m => m.id === id);
}

// A model id that a server advertises but the static catalog doesn't know
// about. Treated as a cloned-voice backend (like Chatterbox/OpenAudio): voices
// come from the server's /v1/audio/voices and the per-chapter language is
// forwarded. Lets new server-side backends (e.g. Orpheus) work without a
// code change here.
export function clonedVoiceModel(id: string): TtsModel {
  return { id, label: id, usesLanguage: true, named: false, fallbackVoices: [] };
}

// Resolve a model id to its metadata, falling back to a cloned-voice model for
// ids the static catalog doesn't list.
export function resolveModel(id: string): TtsModel {
  return getModel(id) ?? clonedVoiceModel(id);
}

const DEFAULT_MODEL = MODELS[0];

// Infer the model for a legacy, unprefixed voice id.
function inferModel(voice: string): TtsModel {
  if (voice === 'default' || /^[a-z]{2}-[A-Z]{2}-/.test(voice)) return getModel('chatterbox')!;
  if (/^[a-z]{2}_/.test(voice)) return getModel('kokoro')!;
  return DEFAULT_MODEL;
}

// Split a composite "model:voice" id into its model + bare voice. Legacy
// unprefixed ids are routed by inference (no DB migration needed).
export function parseVoice(composite: string): { model: TtsModel; voice: string } {
  const sep = composite.indexOf(':');
  if (sep > 0) {
    return { model: resolveModel(composite.slice(0, sep)), voice: composite.slice(sep + 1) };
  }
  return { model: inferModel(composite), voice: composite };
}
