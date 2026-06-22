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

export function expandReferences(text: string, books: Map<string, string>, conn: Connectives): string {
  return text.replace(REF_RE, (match, num, wordsRaw, chap, v1, v2, rest) => {
    const numArabic = num ? (ROMAN[num.toLowerCase()] ?? num) : '';
    const words = wordsRaw.trim().split(/\s+/);
    const hit = matchBook(books, numArabic, words);
    if (!hit) return match; // not a known book -> leave untouched

    const preamble = words.slice(0, words.length - hit.take);
    const pre = preamble.length ? preamble.join(' ') + ' ' : '';

    let spoken = `${hit.say} ${conn.chapter} ${chap} ${conn.verse} ${v1}`;
    if (v2) spoken += ` ${conn.through} ${v2}`;

    if (rest) {
      for (const item of rest.split(',')) {
        const m = item.trim().match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
        if (!m) continue;
        spoken += ` ${conn.and} ${m[1]}` + (m[2] ? ` ${conn.through} ${m[2]}` : '');
      }
    }
    return pre + spoken;
  });
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
  out = expandAcronyms(out, await getAcronyms(lang));
  return out;
}
