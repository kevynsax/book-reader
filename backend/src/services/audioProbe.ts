import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);
const exec = (file: string, args: string[]) =>
  execFileAsync(file, args, { maxBuffer: 256 * 1024 * 1024 });

// Concatenate the audio files listed in a concat-demuxer manifest into one mp3,
// optionally scaling volume. Always decodes and re-encodes: raw mp3 byte-concat
// drops ~20ms of audio at every segment boundary (frames aren't independently
// joinable), which desyncs the read-along timeline; decoding to PCM first makes
// the join sample-accurate so segment durations sum exactly to the output.
export async function concatAudio(listPath: string, output: string, volume = 1): Promise<void> {
  const args = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listPath];
  if (volume !== 1) args.push('-filter:a', `volume=${volume}`);
  args.push('-c:a', 'libmp3lame', '-q:a', '2', '-write_xing', '1', output);
  await exec('ffmpeg', args);
}

// Re-encode an in-memory mp3 with a volume scale (used to boost title segments
// before they're concatenated into the chapter).
export async function applyVolume(buffer: Buffer, volume: number): Promise<Buffer> {
  if (volume === 1) return buffer;
  const base = path.join(os.tmpdir(), `vol_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const inPath = `${base}_in.mp3`;
  const outPath = `${base}_out.mp3`;
  try {
    await fs.writeFile(inPath, buffer);
    await exec('ffmpeg', [
      '-y', '-v', 'error', '-i', inPath,
      '-filter:a', `volume=${volume}`, '-c:a', 'libmp3lame', '-q:a', '2',
      outPath,
    ]);
    return await fs.readFile(outPath);
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

// Sample rate and channel count of a file's first audio stream, so generated
// silence matches the TTS segments it sits between.
export async function probeAudioFormat(file: string): Promise<{ sampleRate: number; channels: number }> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels',
    '-of', 'default=noprint_wrappers=1',
    file,
  ]);
  let sampleRate = 0;
  let channels = 0;
  for (const line of stdout.trim().split('\n')) {
    const [key, value] = line.split('=');
    if (key === 'sample_rate') sampleRate = parseInt(value, 10);
    else if (key === 'channels') channels = parseInt(value, 10);
  }
  return { sampleRate: sampleRate || 24000, channels: channels || 1 };
}

// An mp3 buffer of pure silence, format-matched so it can be raw-concatenated
// with TTS segments before the final re-encode.
export async function generateSilence(durationSecs: number, sampleRate: number, channels: number): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `silence_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
  try {
    await exec('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi',
      '-i', `anullsrc=r=${sampleRate}:cl=${channels === 1 ? 'mono' : 'stereo'}`,
      '-t', String(durationSecs),
      '-c:a', 'libmp3lame', '-q:a', '2',
      tmp,
    ]);
    return await fs.readFile(tmp);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

// True decoded duration in seconds: the number of samples the decoder actually
// emits, which is what concat and playback use. This differs from format=duration
// for files carrying a LAME/Xing gapless tag (libmp3lame output — generated
// silence, re-encoded title boosts), where format=duration counts the encoder
// delay/padding the decoder strips. Summed decoded durations equal the concat
// output exactly, so the read-along timeline stays locked to the audio.
export async function decodedDurationSecs(file: string): Promise<number> {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-progress', 'pipe:1', '-']);
  const matches = stdout.match(/out_time_us=(\d+)|out_time_ms=(\d+)/g) ?? [];
  const last = matches[matches.length - 1];
  const us = last ? parseInt(last.split('=')[1], 10) : NaN;
  if (!isFinite(us) || us <= 0) throw new Error(`ffmpeg returned no duration for ${file}`);
  return us / 1e6;
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
