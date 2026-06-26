import { AudioStatus, Book, Chapter, VoiceTrack } from '../types';

// Strip a composite "engine:voice" prefix to the bare voice id. Any engine
// prefix is stripped — bare ids never contain ':' (edge ids use '-', Kokoro '_').
export function bareVoice(voice: string): string {
  const sep = voice.indexOf(':');
  return sep > 0 ? voice.slice(sep + 1) : voice;
}

// Engine id for a (possibly legacy/unprefixed) composite voice.
export function engineOf(composite: string): string {
  const sep = composite.indexOf(':');
  if (sep > 0) return composite.slice(0, sep);
  if (composite === 'default' || /^[a-z]{2}-[A-Z]{2}-/.test(composite)) return 'chatterbox';
  if (/^[a-z]{2}_/.test(composite)) return 'kokoro';
  return 'chatterbox';
}

export function friendlyVoice(composite: string): string {
  const voice = bareVoice(composite);
  if (!voice) return '';
  if (voice === 'default') return 'Default';
  // Edge ids: <lang>-<REGION>-<Name>[Multilingual]Neural  e.g. en-US-AvaNeural, pt-BR-ThalitaMultilingualNeural
  const parts = voice.split('-');
  if (parts.length >= 3) {
    const region = parts[1];
    const name = parts.slice(2).join('-').replace(/(Multilingual)?Neural$/i, '');
    return `${name} (${region})`;
  }
  // legacy Kokoro ids like pf_dora -> Dora
  return voice.split('_').slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ') || voice;
}

export function bookVoices(book: Book): string[] {
  if (book.voices?.length) return book.voices;
  const legacy = (book as unknown as { voice?: string }).voice;
  return legacy ? [legacy] : [];
}

export function trackFor(chapter: Chapter, voice: string): VoiceTrack | undefined {
  const t = chapter.tracks?.find(t => t.voice === voice);
  if (t) return t;
  const legacy = chapter as unknown as VoiceTrack & { audioStatus?: AudioStatus };
  if (legacy.audioStatus) {
    return { voice, audioPath: legacy.audioPath, audioDurationSecs: legacy.audioDurationSecs, audioStatus: legacy.audioStatus };
  }
  return undefined;
}

export function chapterStatus(chapter: Chapter, voices?: string[]): AudioStatus {
  const tracks = (chapter.tracks ?? []).filter(t => !voices || voices.includes(t.voice));
  if (tracks.length === 0) return 'pending';
  if (tracks.some(t => t.audioStatus === 'generating')) return 'generating';
  if (tracks.some(t => t.audioStatus === 'error')) return 'error';
  if (tracks.some(t => t.audioStatus === 'stale')) return 'stale';
  if (tracks.every(t => t.audioStatus === 'complete')) return 'complete';
  return 'pending';
}

// True once at least one chapter has finished rendering in some voice — i.e.
// there is something to listen to even while the rest is still generating.
export function hasPlayableAudio(book: Book): boolean {
  const voices = bookVoices(book);
  return book.chapters.some(c => voices.some(v => trackFor(c, v)?.audioStatus === 'complete'));
}

export function fmtRemaining(s: number): string {
  if (!isFinite(s) || s <= 0) return '';
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.ceil(s / 60)}m`;
}
