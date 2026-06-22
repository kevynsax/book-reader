import { CHATTERBOX_API, KOKORO_API } from '../config.js';

// A selectable TTS "model"/engine. Both speak the OpenAI audio shape.
export interface TtsEngine {
  id: string;
  label: string;
  api: string;          // base URL
  model: string;        // value sent as `model` in the request body
  usesLanguage: boolean; // forward the per-chapter language as lang_code?
  fallbackVoices: string[]; // used if the engine's /v1/audio/voices is unreachable
}

// Curated Chatterbox clone voices (the mp3 clips in tts-2/voices/).
const CHATTERBOX_VOICES = [
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

// Order matters: the first entry is the default engine.
export const ENGINES: TtsEngine[] = [
  { id: 'chatterbox', label: 'Chatterbox (local)', api: CHATTERBOX_API, model: 'chatterbox', usesLanguage: true, fallbackVoices: CHATTERBOX_VOICES },
  { id: 'kokoro', label: 'Kokoro', api: KOKORO_API, model: 'kokoro', usesLanguage: false, fallbackVoices: KOKORO_VOICES },
];

export function getEngine(id: string): TtsEngine | undefined {
  return ENGINES.find(e => e.id === id);
}

// Probe the engine's Swagger/OpenAPI endpoint to see if it's reachable. The
// Chatterbox server runs on a laptop that's frequently offline, so callers use
// this to surface availability in the UI.
export async function isEngineUp(engine: TtsEngine): Promise<boolean> {
  try {
    const res = await fetch(`${engine.api}/openapi.json`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

const DEFAULT_ENGINE = ENGINES[0];

// Infer the engine for a legacy, unprefixed voice id.
function inferEngine(voice: string): TtsEngine {
  // Edge-style "xx-YY-Name" or the Chatterbox built-in "default".
  if (voice === 'default' || /^[a-z]{2}-[A-Z]{2}-/.test(voice)) return getEngine('chatterbox')!;
  // Kokoro names look like "pf_dora", "af_heart".
  if (/^[a-z]{2}_/.test(voice)) return getEngine('kokoro')!;
  return DEFAULT_ENGINE;
}

// Split a composite "engine:voice" id into its engine + bare voice. Legacy
// unprefixed ids are routed by inference (no DB migration needed).
export function parseVoice(composite: string): { engine: TtsEngine; voice: string } {
  const sep = composite.indexOf(':');
  if (sep > 0) {
    const engine = getEngine(composite.slice(0, sep));
    if (engine) return { engine, voice: composite.slice(sep + 1) };
  }
  return { engine: inferEngine(composite), voice: composite };
}
