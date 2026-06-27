import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  TTS_SPEED, DEFAULT_LANGUAGE, TTS_VOLUME_GAIN, TITLE_MAX_WORDS, TITLE_SILENCE_SECS, TITLE_VOLUME_GAIN,
  TTS_VERIFY, TTS_VERIFY_THRESHOLD, TTS_VERIFY_MAX_DEPTH, TTS_VERIFY_MIN_CHARS, SLM_SPLIT_MODEL,
} from '../config.js';
import { concatAudio, probeDurationSecs, decodedDurationSecs, probeMp3Buffer, probeAudioFormat, generateSilence, applyVolume } from './audioProbe.js';
import { normalizeForSpeech } from './textNormalizer.js';
import { isTitle, splitOnPunctuation } from '../lib/sentences.js';
import { wordSimilarity } from '../lib/verify.js';
import { parseVoice, TtsModel } from './ttsEngines.js';
import { pickReadyServer } from './ttsServers.js';
import { transcribeAudio } from './whisperService.js';
import { splitLineIntoSentences } from './ocrService.js';

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

// Everything needed to (re-)render a chunk on the server originally picked for
// this segment, threaded through the verify/split recursion.
interface RenderContext {
  serverUrl: string;
  model: TtsModel;
  voice: string;
  speed: number;
  language: string;
}

// Synthesize one chunk to an mp3 buffer, retrying transient failures so a single
// dropped request doesn't fail the chapter.
async function renderChunkToBuffer(text: string, ctx: RenderContext): Promise<{ buffer: Buffer; durationSecs: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
    try {
      return await synthesizeChunk(text, ctx.serverUrl, ctx.model, ctx.voice, ctx.speed, ctx.language);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Join rendered mp3 buffers into one (PCM-domain concat + re-encode), no gain —
// chapter assembly applies the volume boost later.
async function concatBuffers(buffers: Buffer[]): Promise<Buffer> {
  if (buffers.length === 1) return buffers[0];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'segpieces-'));
  try {
    const files: string[] = [];
    for (let i = 0; i < buffers.length; i++) {
      const f = path.join(dir, `p${String(i).padStart(3, '0')}.mp3`);
      await fs.writeFile(f, buffers[i]);
      files.push(f);
    }
    const listPath = path.join(dir, 'list.txt');
    await fs.writeFile(listPath, files.map(concatLine).join('\n'));
    const outPath = path.join(dir, 'out.mp3');
    await concatAudio(listPath, outPath);
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Break the ORIGINAL (un-normalized) sentence text that failed verification into
// two: first on punctuation (period → colon → semicolon → comma, nearest the
// middle), then, if there's no usable punctuation, by asking gemma to divide it
// while preserving meaning. Splitting the original — not the dictionary/bible-ref
// expanded speech text — keeps each piece's on-screen display clean.
async function splitForRerender(display: string): Promise<[string, string] | null> {
  const byPunct = splitOnPunctuation(display);
  if (byPunct) return byPunct;

  try {
    const sug = await splitLineIntoSentences(display, SLM_SPLIT_MODEL);
    const left = sug?.left?.trim();
    const right = sug?.right?.trim();
    if (left && right) return [left, right];
  } catch (err) {
    console.warn('SLM split failed:', err instanceof Error ? err.message : err);
  }
  return null;
}

// One verified leaf of a sentence: the original `display` text, the speech-ready
// `text` actually synthesized, and the audio confirmed (within tolerance) to say it.
export interface RenderedPiece {
  display: string;
  text: string;
  buffer: Buffer;
  durationSecs: number;
}

// Render a chunk and confirm — via Whisper — that it says what was asked. The
// `text` (speech-normalized) is what's synthesized, whispered, and compared; the
// `display` (original) is what gets split on a mismatch, with each original half
// re-normalized for its own render. Returns the flat list of verified leaves
// (length 1 when it rendered cleanly, can't be split, or hit the depth cap — best
// attempt kept).
async function renderVerifiedPieces(display: string, text: string, ctx: RenderContext, depth = 0): Promise<RenderedPiece[]> {
  const result = await renderChunkToBuffer(text, ctx);
  const leaf: RenderedPiece = { display, text, buffer: result.buffer, durationSecs: result.durationSecs };

  if (!TTS_VERIFY || text.trim().length < TTS_VERIFY_MIN_CHARS) return [leaf];

  const transcript = await transcribeAudio(result.buffer, ctx.language);
  if (transcript === null) return [leaf]; // ASR unavailable — don't block on it

  const similarity = wordSimilarity(text, transcript);
  if (similarity >= TTS_VERIFY_THRESHOLD) return [leaf];

  if (depth >= TTS_VERIFY_MAX_DEPTH) {
    console.warn(`tts verify: keeping best after ${depth} splits (sim=${similarity.toFixed(2)}) for "${display.slice(0, 60)}"`);
    return [leaf];
  }

  const parts = await splitForRerender(display);
  if (!parts) {
    console.warn(`tts verify: unsplittable mismatch (sim=${similarity.toFixed(2)}) for "${display.slice(0, 60)}"`);
    return [leaf];
  }

  const pieces: RenderedPiece[] = [];
  for (const part of parts) {
    const speakable = (await normalizeForSpeech(part, ctx.language)).trim() || part;
    pieces.push(...await renderVerifiedPieces(part, speakable, ctx, depth + 1));
  }
  return pieces;
}

// Verify a sentence and return the leaf pieces it broke down into (one entry when
// nothing needed splitting). `display` is the original sentence text and `text` is
// its speech-ready form; pass them equal when there's no separate display. The
// caller decides whether to persist the pieces as real sentences or stitch their
// audio back into one segment.
export async function renderSegmentPieces(
  display: string,
  text: string,
  serverUrl: string,
  voice: string,
  language: string = DEFAULT_LANGUAGE,
  speed: number = TTS_SPEED,
): Promise<RenderedPiece[]> {
  const { model, voice: bareVoice } = parseVoice(voice);
  const speakable = text.trim();
  if (!speakable) throw new Error('Empty sentence');
  return renderVerifiedPieces(display.trim() || speakable, speakable, { serverUrl, model, voice: bareVoice, speed, language });
}

// Render one sentence to its own mp3 file, verifying it against Whisper. On a
// mismatch the verified pieces are stitched back into a single segment (used by
// the single-sentence edit/regenerate path, which doesn't restructure sentences).
// Returns the duration.
export async function synthesizeSegment(
  text: string,
  outputPath: string,
  serverUrl: string,
  voice: string,
  language: string = DEFAULT_LANGUAGE,
  speed: number = TTS_SPEED,
): Promise<number> {
  const pieces = await renderSegmentPieces(text, text, serverUrl, voice, language, speed);
  const buffer = await concatBuffers(pieces.map(p => p.buffer));
  const durationSecs = pieces.length === 1 ? pieces[0].durationSecs : await probeMp3Buffer(buffer);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
  return durationSecs;
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
