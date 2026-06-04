import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

/**
 * Losslessly remux an MP3 through ffmpeg so it carries an accurate Xing/Info
 * header. Kokoro output (and especially byte-concatenated multi-chunk audio)
 * often lacks a reliable duration header, which makes browsers estimate
 * `audio.duration` from the bitrate and report it short.
 *
 * `-c:a copy` copies the audio frames bit-for-bit — there is NO re-encode and
 * therefore NO quality loss — while the mp3 muxer (`-write_xing 1`) writes a
 * fresh header with the real frame count, so ffprobe and the browser both see
 * the true length.
 */
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

/** Read the true duration (in seconds) of an audio file via ffprobe. */
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
