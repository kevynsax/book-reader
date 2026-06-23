import fs from 'fs/promises';
import path from 'path';
import { TTS_SPEED, DEFAULT_LANGUAGE, TTS_VOLUME_GAIN, TITLE_MAX_WORDS, TITLE_SILENCE_SECS, TITLE_VOLUME_GAIN } from '../config.js';
import { concatAudio, probeDurationSecs, decodedDurationSecs, probeMp3Buffer, probeAudioFormat, generateSilence, applyVolume } from './audioProbe.js';
import { normalizeForSpeech } from './textNormalizer.js';
import { isTitle } from '../lib/sentences.js';
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

// A concat-demuxer manifest entry. Paths are absolute and single-quotes escaped
// so ffmpeg resolves them regardless of cwd.
function concatLine(file: string): string {
  return `file '${path.resolve(file).replace(/'/g, `'\\''`)}'`;
}

// Resolve promises with at most `limit` in flight, preserving input order.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  }));
  return out;
}

// Concatenate per-sentence mp3 segments into the final chapter mp3 and write the
// read-along timeline. The segments are joined in the PCM domain (concat demuxer
// + re-encode) so the join is sample-accurate. Timeline offsets are summed from
// each file's *real* decoded duration — not the stored segment durationSecs, which
// some TTS servers report as the pre-encode length (the mp3 carries extra encoder
// delay/padding) — so highlights stay locked to the audio across a long chapter.
export async function assembleChapter(
  segments: { audioPath: string; durationSecs: number; text: string; display?: string }[],
  outputPath: string,
): Promise<number> {
  if (segments.length === 0) throw new Error('No segments to assemble');

  const tmpDir = path.dirname(outputPath);
  const base = path.basename(outputPath);
  const listPath = path.join(tmpDir, `_list_${base}.txt`);
  const silencePath = path.join(tmpDir, `_silence_${base}.mp3`);
  const boostedPaths: string[] = [];

  try {
    let silenceFile: string | null = null;
    let silenceDur = 0;
    if (segments.some(s => isTitle(s.text, TITLE_MAX_WORDS))) {
      const { sampleRate, channels } = await probeAudioFormat(segments[0].audioPath);
      await fs.writeFile(silencePath, await generateSilence(TITLE_SILENCE_SECS, sampleRate, channels));
      silenceFile = silencePath;
      silenceDur = await decodedDurationSecs(silencePath);
    }

    // The actual file fed into the concat for each sentence — the original
    // segment, or a temp gain-boosted copy for titles (the demuxer can't apply
    // per-file gain, so it's pre-baked here).
    const files = await mapLimit(segments, 8, async (seg, i) => {
      if (!(silenceFile && isTitle(seg.text, TITLE_MAX_WORDS))) return seg.audioPath;
      const file = path.join(tmpDir, `_title_${i}_${base}.mp3`);
      await fs.writeFile(file, await applyVolume(await fs.readFile(seg.audioPath), TITLE_VOLUME_GAIN));
      boostedPaths.push(file);
      return file;
    });
    const durations = await mapLimit(files, 16, f => decodedDurationSecs(f));

    const lines: string[] = [];
    const timeline: TimelineEntry[] = [];
    let cursor = 0;
    segments.forEach((seg, i) => {
      const title = silenceFile && isTitle(seg.text, TITLE_MAX_WORDS);
      if (title) { lines.push(concatLine(silenceFile!)); cursor += silenceDur; }
      lines.push(concatLine(files[i]));
      timeline.push({ text: seg.display ?? seg.text, start: +cursor.toFixed(3), end: +(cursor + durations[i]).toFixed(3) });
      cursor += durations[i];
      if (title) { lines.push(concatLine(silenceFile!)); cursor += silenceDur; }
    });

    await fs.writeFile(listPath, lines.join('\n'));
    await concatAudio(listPath, outputPath, TTS_VOLUME_GAIN);
    const finalDuration = await probeDurationSecs(outputPath);

    await fs.writeFile(timelinePathFor(outputPath), JSON.stringify(timeline));

    return finalDuration;
  } finally {
    await fs.unlink(listPath).catch(() => {});
    await fs.unlink(silencePath).catch(() => {});
    await Promise.all(boostedPaths.map(f => fs.unlink(f).catch(() => {})));
  }
}
