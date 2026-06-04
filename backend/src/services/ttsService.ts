import fs from 'fs/promises';
import path from 'path';
import { TTS_API, KOKORO_VOICE, KOKORO_SPEED } from '../config.js';
import { normalizeMp3, probeDurationSecs } from './audioProbe.js';

const MAX_CHUNK_CHARS = 3000;

function splitTextIntoChunks(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > MAX_CHUNK_CHARS && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export async function synthesizeSample(text: string, voice: string): Promise<Buffer> {
  return synthesizeChunk(text.slice(0, 1500), voice, KOKORO_SPEED);
}

async function synthesizeChunk(text: string, voice: string, speed: number): Promise<Buffer> {
  const res = await fetch(`${TTS_API}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kokoro',
      input: text,
      voice,
      response_format: 'mp3',
      speed,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(err || `TTS API returned ${res.status}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

export async function generateAudio(
  text: string,
  outputPath: string,
  voice: string = KOKORO_VOICE,
  speed: number = KOKORO_SPEED
): Promise<number> {
  const chunks = splitTextIntoChunks(text);
  const tmpDir = path.dirname(outputPath);
  const rawPath = path.join(tmpDir, `_raw_${path.basename(outputPath)}_${Date.now()}.mp3`);

  try {
    if (chunks.length === 1) {
      await fs.writeFile(rawPath, await synthesizeChunk(chunks[0], voice, speed));
    } else {
      const buffers: Buffer[] = [];
      for (let i = 0; i < chunks.length; i++) {
        buffers.push(await synthesizeChunk(chunks[i], voice, speed));
      }
      await fs.writeFile(rawPath, Buffer.concat(buffers));
    }

    await normalizeMp3(rawPath, outputPath);
    return await probeDurationSecs(outputPath);
  } finally {
    await fs.unlink(rawPath).catch(() => {});
  }
}
