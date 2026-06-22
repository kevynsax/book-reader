import fs from 'fs/promises';
import path from 'path';
import { TTS_SPEED, DEFAULT_LANGUAGE } from '../config.js';
import { normalizeMp3, probeDurationSecs, probeMp3Buffer } from './audioProbe.js';
import { normalizeForSpeech } from './textNormalizer.js';
import { splitIntoSentences } from '../lib/sentences.js';
import { parseVoice, TtsModel } from './ttsEngines.js';
import { pickReadyServer } from './ttsServers.js';

export interface TimelineEntry {
  text: string;
  start: number;
  end: number;
}

// A request to TTS that takes longer than this is treated as a failure so a
// stuck server doesn't hang a whole chapter.
const CHUNK_TIMEOUT_MS = 180_000;
const CHUNK_RETRIES = 2;

// Path of the read-along timeline JSON for a given chapter audio file.
export function timelinePathFor(audioPath: string): string {
  return `${audioPath}.timeline.json`;
}

// Speech-ready sentences for a chapter: normalize once, then split. The result
// is what gets stored as the editable source of truth (no re-normalization on
// edit, so a fix renders exactly what you typed).
export async function buildSpeakableSentences(text: string, language: string): Promise<string[]> {
  const speakable = await normalizeForSpeech(text, language);
  return splitIntoSentences(speakable);
}

export async function synthesizeSample(text: string, voice: string): Promise<Buffer> {
  const { model, voice: bareVoice } = parseVoice(voice);
  const server = await pickReadyServer(model.id);
  if (!server) throw new Error(`No TTS server available for model "${model.id}"`);
  const speakable = await normalizeForSpeech(text.slice(0, 1500), DEFAULT_LANGUAGE);
  const { buffer } = await synthesizeChunk(speakable, server.url, model, bareVoice, TTS_SPEED, DEFAULT_LANGUAGE);
  return buffer;
}

async function synthesizeChunk(
  text: string,
  serverUrl: string,
  model: TtsModel,
  voice: string,
  speed: number,
  language: string,
): Promise<{ buffer: Buffer; durationSecs: number }> {
  const body: Record<string, unknown> = {
    model: model.id,
    input: text,
    voice,
    response_format: 'mp3',
    speed,
  };
  if (model.usesLanguage) body.language = language;

  const res = await fetch(`${serverUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(err || `TTS API returned ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  // Chatterbox returns the duration; for engines that don't (Kokoro), probe it.
  const header = res.headers.get('X-Audio-Duration-Seconds');
  const durationSecs = header ? parseFloat(header) : await probeMp3Buffer(buffer);
  return { buffer, durationSecs };
}

// Render one sentence to its own mp3 file, retrying transient failures so a
// single dropped request doesn't fail the chapter. Returns the duration.
export async function synthesizeSegment(
  text: string,
  outputPath: string,
  serverUrl: string,
  voice: string,
  language: string = DEFAULT_LANGUAGE,
  speed: number = TTS_SPEED,
): Promise<number> {
  const { model, voice: bareVoice } = parseVoice(voice);
  const speakable = text.trim();
  if (!speakable) throw new Error('Empty sentence');

  let lastErr: unknown;
  for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
    try {
      const { buffer, durationSecs } = await synthesizeChunk(speakable, serverUrl, model, bareVoice, speed, language);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, buffer);
      return durationSecs;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Concatenate per-sentence mp3 segments into the final chapter mp3 and write the
// read-along timeline. Segment durations are summed then scaled to the probed
// file duration so highlight anchoring survives the concat/re-encode.
export async function assembleChapter(
  segments: { audioPath: string; durationSecs: number; text: string }[],
  outputPath: string,
): Promise<number> {
  if (segments.length === 0) throw new Error('No segments to assemble');

  const tmpDir = path.dirname(outputPath);
  const rawPath = path.join(tmpDir, `_raw_${path.basename(outputPath)}.mp3`);

  try {
    const buffers: Buffer[] = [];
    const timeline: TimelineEntry[] = [];
    let cursor = 0;
    for (const seg of segments) {
      buffers.push(await fs.readFile(seg.audioPath));
      timeline.push({ text: seg.text, start: cursor, end: cursor + seg.durationSecs });
      cursor += seg.durationSecs;
    }

    await fs.writeFile(rawPath, Buffer.concat(buffers));
    await normalizeMp3(rawPath, outputPath);
    const finalDuration = await probeDurationSecs(outputPath);

    const scale = cursor > 0 ? finalDuration / cursor : 1;
    const scaled = timeline.map(e => ({
      text: e.text,
      start: +(e.start * scale).toFixed(3),
      end: +(e.end * scale).toFixed(3),
    }));
    await fs.writeFile(timelinePathFor(outputPath), JSON.stringify(scaled));

    return finalDuration;
  } finally {
    await fs.unlink(rawPath).catch(() => {});
  }
}
