import { execFile } from 'child_process';
import { promisify } from 'util';

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
