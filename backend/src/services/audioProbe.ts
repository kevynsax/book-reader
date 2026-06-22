import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const exec = promisify(execFile);

export async function normalizeMp3(input: string, output: string): Promise<void> {
  await exec('ffmpeg', [
    '-y',
    '-v', 'error',
    '-i', input,
    '-c:a', 'copy',
    '-write_xing', '1',
    output,
  ]);
}

export async function probeDurationSecs(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const secs = parseFloat(stdout.trim());
  if (!isFinite(secs) || secs <= 0) throw new Error(`ffprobe returned no duration for ${file}`);
  return secs;
}

// Duration of an in-memory mp3 (for engines that don't return a duration header).
export async function probeMp3Buffer(buffer: Buffer): Promise<number> {
  const tmp = path.join(os.tmpdir(), `probe_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
  try {
    await fs.writeFile(tmp, buffer);
    return await probeDurationSecs(tmp);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
