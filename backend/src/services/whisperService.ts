import { WHISPER_SERVERS, WHISPER_MODEL, WHISPER_TIMEOUT_MS } from '../config.js';

// Live count of in-flight requests per server, so transcription work spreads to
// the least-busy box and a slow/down server doesn't bottleneck the batch.
const inFlight = new Map<string, number>();
const load = (url: string) => inFlight.get(url) ?? 0;

// Servers cheapest-first by current load; ties keep configured order (primary
// first). The chosen server is tried first and the rest act as fallback.
function orderedServers(): string[] {
  return [...WHISPER_SERVERS].sort((a, b) => load(a) - load(b));
}

async function transcribeOn(base: string, audio: Buffer, language?: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'segment.mp3');
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  inFlight.set(base, load(base) + 1);
  try {
    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(err || `Whisper API returned ${res.status}`);
    }
    const data = await res.json() as { text?: string };
    return (data?.text ?? '').trim();
  } finally {
    inFlight.set(base, Math.max(0, load(base) - 1));
  }
}

// Transcribe an mp3 buffer, trying the least-busy server first and falling back
// to the others on error. Returns null if every server fails (caller then keeps
// the audio rather than blocking the chapter on a flaky ASR box).
export async function transcribeAudio(audio: Buffer, language?: string): Promise<string | null> {
  const servers = orderedServers();
  if (servers.length === 0) return null;
  for (const base of servers) {
    try {
      return await transcribeOn(base, audio, language);
    } catch (err) {
      console.warn(`whisper ${base} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}
