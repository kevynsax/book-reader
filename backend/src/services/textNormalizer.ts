import { BIBLE_BOOKS, CONNECTIVES, normKey, Connectives } from '../data/bibleBooks.js';
import { getAcronyms } from './lexiconService.js';
import { IAcronym } from '../models/Lexicon.js';

const ROMAN: Record<string, string> = { i: '1', ii: '2', iii: '3' };

// Matches a Bible reference: optional book number (1/2/3 or I/II/III), 1-3 book
// words, then chapter:verse with an optional range and comma-separated tail.
// The required `\d+:\d+` is what keeps short abbreviations from matching prose.
const REF_RE =
  /(?<![\p{L}\d])(?:([123]|i{1,3})\s*)?((?:\p{L}[\p{L}.]*)(?:\s+\p{L}[\p{L}.]*){0,2})\s+(\d+):(\d+)(?:\s*[-–—]\s*(\d+))?((?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)+)?/giu;

function effectiveLang(language: string): string {
  return language && BIBLE_BOOKS[language] ? language : 'en';
}

// Find the longest book name that forms a suffix of the captured words.
function matchBook(
  books: Map<string, string>,
  numArabic: string,
  words: string[],
): { say: string; take: number } | null {
  for (let take = words.length; take >= 1; take--) {
    const suffix = words.slice(words.length - take).join(' ');
    const key = (numArabic ? numArabic + ' ' : '') + normKey(suffix);
    const say = books.get(key);
    if (say) return { say, take };
  }
  return null;
}

function speakVerses(conn: Connectives, v1: string, v2: string, rest: string, forcePlural = false): string {
  const plural = forcePlural || !!v2 || !!rest;
  let spoken = `${plural ? conn.verses : conn.verse} ${v1}`;
  if (v2) spoken += ` ${conn.through} ${v2}`;
  if (rest) {
    for (const item of rest.split(',')) {
      const m = item.trim().match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
      if (!m) continue;
      spoken += ` ${conn.and} ${m[1]}` + (m[2] ? ` ${conn.through} ${m[2]}` : '');
    }
  }
  return spoken;
}

export function expandReferences(text: string, books: Map<string, string>, conn: Connectives): string {
  return text.replace(REF_RE, (match, num, wordsRaw, chap, v1, v2, rest) => {
    const numArabic = num ? (ROMAN[num.toLowerCase()] ?? num) : '';
    const words = wordsRaw.trim().split(/\s+/);
    const hit = matchBook(books, numArabic, words);
    if (!hit) return match; // not a known book -> leave untouched

    const preamble = words.slice(0, words.length - hit.take);
    const pre = preamble.length ? preamble.join(' ') + ' ' : '';

    return `${pre}${hit.say} ${conn.chapter} ${chap} ${speakVerses(conn, v1, v2, rest)}`;
  });
}

const BARE_REF_RE =
  /(?<![\p{L}\d:])(\d+):(\d+)(?:\s*[-–—]\s*(\d+))?((?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)+)?(?![:\d])/giu;

export function expandBareReferences(text: string, conn: Connectives): string {
  return text.replace(BARE_REF_RE, (_m, chap, v1, v2, rest) =>
    `${conn.chapter} ${chap} ${speakVerses(conn, v1, v2, rest)}`,
  );
}

const VERSE_RE =
  /\b(vv?)\.\s*(\d+)(?:\s*[-–—]\s*(\d+))?((?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)+)?/gi;

export function expandVerseRefs(text: string, conn: Connectives): string {
  return text.replace(VERSE_RE, (_m, tok, v1, v2, rest) =>
    speakVerses(conn, v1, v2, rest, tok.toLowerCase() === 'vv'),
  );
}

const PAGE_RE = /\(?\bpp?\.\s*(\d+)(?:\s*[-–—]\s*(\d+))?\)?/gi;

export function expandPages(text: string, conn: Connectives): string {
  return text.replace(PAGE_RE, (_m, p1, p2) =>
    p2 ? `${conn.pages} ${p1} ${conn.through} ${p2}` : `${conn.page} ${p1}`,
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word, case-sensitive acronym expansion (uppercase NVI matches; lowercase
// words don't). Longest terms first so e.g. "NKJV" beats "KJV".
export function expandAcronyms(text: string, acronyms: IAcronym[]): string {
  if (!acronyms.length) return text;
  const sorted = [...acronyms].sort((a, b) => b.term.length - a.term.length);
  const say = new Map(sorted.map(a => [a.term, a.say]));
  const re = new RegExp(`\\b(${sorted.map(a => escapeRe(a.term)).join('|')})\\b`, 'g');
  return text.replace(re, m => say.get(m) ?? m);
}

// Rewrite text into a more speakable form for TTS. Read-time only — never mutate
// stored OCR/edited text. Falls back to English tables for unknown languages.
export async function normalizeForSpeech(text: string, language: string): Promise<string> {
  if (!text) return text;
  const lang = effectiveLang(language);
  let out = expandReferences(text, BIBLE_BOOKS[lang], CONNECTIVES[lang]);
  out = expandVerseRefs(out, CONNECTIVES[lang]);
  out = expandBareReferences(out, CONNECTIVES[lang]);
  out = expandPages(out, CONNECTIVES[lang]);
  out = expandAcronyms(out, await getAcronyms(lang));
  return out;
}
