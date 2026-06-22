import fs from 'fs/promises';
import path from 'path';
import { DEFAULT_VOICE, TTS_SPEED, DEFAULT_LANGUAGE } from '../config.js';
import { normalizeMp3, probeDurationSecs, probeMp3Buffer } from './audioProbe.js';
import { normalizeForSpeech } from './textNormalizer.js';
import { splitIntoSentences } from '../lib/sentences.js';
import { parseVoice, TtsEngine } from './ttsEngines.js';

export interface TimelineEntry {
  text: string;
  start: number;
  end: number;
}

// Path of the read-along timeline JSON for a given chapter audio file.
export function timelinePathFor(audioPath: string): string {
  return `${audioPath}.timeline.json`;
}

export async function synthesizeSample(text: string, voice: string): Promise<Buffer> {
  const { engine, voice: bareVoice } = parseVoice(voice);
  const speakable = await normalizeForSpeech(text.slice(0, 1500), DEFAULT_LANGUAGE);
  const { buffer } = await synthesizeChunk(speakable, engine, bareVoice, TTS_SPEED, DEFAULT_LANGUAGE);
  return buffer;
}

async function synthesizeChunk(
  text: string,
  engine: TtsEngine,
  voice: string,
  speed: number,
  language: string,
): Promise<{ buffer: Buffer; durationSecs: number }> {
  const body: Record<string, unknown> = {
    model: engine.model,
    input: text,
    voice,
    response_format: 'mp3',
    speed,
  };
  if (engine.usesLanguage) body.language = language;

  const res = await fetch(`${engine.api}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

// Generate chapter audio one sentence at a time, recording each sentence's real
// duration so we can write a read-along timeline alongside the mp3.
export async function generateAudio(
  text: string,
  outputPath: string,
  voice: string = DEFAULT_VOICE,
  language: string = DEFAULT_LANGUAGE,
  speed: number = TTS_SPEED
): Promise<number> {
  const { engine, voice: bareVoice } = parseVoice(voice);
  const speakable = await normalizeForSpeech(text, language);
  const sentences = splitIntoSentences(speakable);
  if (sentences.length === 0) throw new Error('No speakable text for chapter');

  const tmpDir = path.dirname(outputPath);
  const rawPath = path.join(tmpDir, `_raw_${path.basename(outputPath)}_${Date.now()}.mp3`);

  try {
    const buffers: Buffer[] = [];
    const timeline: TimelineEntry[] = [];
    let cursor = 0;
    for (const sentence of sentences) {
      const { buffer, durationSecs } = await synthesizeChunk(sentence, engine, bareVoice, speed, language);
      buffers.push(buffer);
      timeline.push({ text: sentence, start: cursor, end: cursor + durationSecs });
      cursor += durationSecs;
    }

    await fs.writeFile(rawPath, Buffer.concat(buffers));
    await normalizeMp3(rawPath, outputPath);
    const finalDuration = await probeDurationSecs(outputPath);

    // Scale the summed per-sentence times to the true file duration so the
    // highlight stays anchored despite concat/re-encode drift.
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
