import { AudioStatus, Book, Chapter, VoiceTrack } from '../types';

// Turn a raw voice id like "pf_dora" into a display name like "Dora".
export function friendlyVoice(voice: string): string {
  if (!voice) return '';
  return voice.split('_').slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// The book's voices, tolerant of the legacy single-`voice` shape that may still
// be sitting in localStorage before the first socket sync replaces it.
export function bookVoices(book: Book): string[] {
  if (book.voices?.length) return book.voices;
  const legacy = (book as unknown as { voice?: string }).voice;
  return legacy ? [legacy] : [];
}

// A chapter's rendered track for a voice, falling back to the legacy chapter-level
// audio fields so a stale localStorage hydrate still plays until the sync lands.
export function trackFor(chapter: Chapter, voice: string): VoiceTrack | undefined {
  const t = chapter.tracks?.find(t => t.voice === voice);
  if (t) return t;
  const legacy = chapter as unknown as VoiceTrack & { audioStatus?: AudioStatus };
  if (legacy.audioStatus) {
    return { voice, audioPath: legacy.audioPath, audioDurationSecs: legacy.audioDurationSecs, audioStatus: legacy.audioStatus };
  }
  return undefined;
}

// Roll a chapter's per-voice tracks up to a single status for progress displays.
// Restricts to `voices` when given, else considers every track.
export function chapterStatus(chapter: Chapter, voices?: string[]): AudioStatus {
  const tracks = (chapter.tracks ?? []).filter(t => !voices || voices.includes(t.voice));
  if (tracks.length === 0) return 'pending';
  if (tracks.some(t => t.audioStatus === 'generating')) return 'generating';
  if (tracks.some(t => t.audioStatus === 'error')) return 'error';
  if (tracks.some(t => t.audioStatus === 'stale')) return 'stale';
  if (tracks.every(t => t.audioStatus === 'complete')) return 'complete';
  return 'pending';
}

// Coarse "time left to hear" label, e.g. "2h 15m" or "8m". Empty when ≤ 0.
export function fmtRemaining(s: number): string {
  if (!isFinite(s) || s <= 0) return '';
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.ceil(s / 60)}m`;
}
