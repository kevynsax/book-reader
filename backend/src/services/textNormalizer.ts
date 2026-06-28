import { BIBLE_BOOKS, CONNECTIVES, normKey, Connectives, resolveLang } from '../data/bibleBooks.js';
import { numberToWords } from '../data/numberWords.js';
import { getAcronyms } from './lexiconService.js';
import { IAcronym } from '../models/Lexicon.js';

const ROMAN: Record<string, string> = { i: '1', ii: '2', iii: '3' };

// The chapter–verse separator differs by language: English uses a colon ("2:3"),
// Portuguese a period ("2.3"). Only the book-anchored REF_RE accepts the period —
// a known book name gates it, so a decimal in prose ("custa 2.3") is never caught.
const CV_SEP: Record<string, string> = { pt: '[:.]', en: ':' };
function cvSep(conn: Connectives): string {
  return CV_SEP[conn.lang] ?? ':';
}

// Matches a Bible reference: optional book number (1/2/3 or I/II/III), 1-3 book
// words, then chapter:verse with an optional range and comma-separated tail.
// The required `\d+<sep>\d+` is what keeps short abbreviations from matching prose.
function refRe(conn: Connectives): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\d])(?:([123]|i{1,3})(?![\\p{L}])\\s*)?((?:\\p{L}[\\p{L}.]*)(?:\\s+\\p{L}[\\p{L}.]*){0,2})\\s+(\\d+)${cvSep(conn)}(\\d+)(?:\\s*[-–—]\\s*(\\d+))?((?:\\s*,\\s*\\d+(?:\\s*[-–—]\\s*\\d+)?)+)?`,
    'giu',
  );
}

function effectiveLang(language: string): string {
  return resolveLang(language);
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

// A dash range of two consecutive numbers ("6-7") reads as "6 and 7"; a wider
// range ("6-9") stays "6 through 9".
function rangeJoin(conn: Connectives, a: string, b: string): string {
  return parseInt(b) - parseInt(a) === 1 ? conn.and : conn.through;
}

// Reference numbers are spoken in full ("38" -> "thirty eight") so the read form
// differs visibly from the source digits in the review diff.
function sayNum(conn: Connectives, n: string): string {
  return numberToWords(parseInt(n, 10), conn.lang);
}

// Join spoken items as a list: comma-separated with the connective "and" before
// the last ("2, 3, 21 and 23"; "6 and 7" for a pair).
function joinList(conn: Connectives, parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} ${conn.and} ${parts[parts.length - 1]}`;
}

// Turn a leading number, an optional "a-b" range, and an optional comma tail of
// numbers/ranges into spoken, spelled-out items ("two", "forty two through forty
// five", "two", "three", "twenty one and twenty three").
function spokenParts(conn: Connectives, v1: string, v2: string, rest: string): string[] {
  const part = (a: string, b?: string) => (b ? `${sayNum(conn, a)} ${rangeJoin(conn, a, b)} ${sayNum(conn, b)}` : sayNum(conn, a));
  const parts = [part(v1, v2)];
  if (rest) {
    for (const item of rest.split(',')) {
      const m = item.trim().match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
      if (m) parts.push(part(m[1], m[2]));
    }
  }
  return parts;
}

// Spoken parts prefixed by a singular/plural label ("verse 5", "verses 2, 3, 21
// and 23", "chapters 6 through 9 and 12").
function speakNumbers(conn: Connectives, singular: string, plural: string, v1: string, v2: string, rest: string, forcePlural = false): string {
  const parts = spokenParts(conn, v1, v2, rest);
  const isPlural = forcePlural || !!v2 || parts.length > 1;
  return `${isPlural ? plural : singular} ${joinList(conn, parts)}`;
}

function speakVerses(conn: Connectives, v1: string, v2: string, rest: string, forcePlural = false): string {
  return speakNumbers(conn, conn.verse, conn.verses, v1, v2, rest, forcePlural);
}

export function expandReferences(text: string, books: Map<string, string>, conn: Connectives): string {
  return text.replace(refRe(conn), (match, num, wordsRaw, chap, v1, v2, rest) => {
    const numArabic = num ? (ROMAN[num.toLowerCase()] ?? num) : '';
    const words = wordsRaw.trim().split(/\s+/);
    const hit = matchBook(books, numArabic, words);
    if (!hit) return match; // not a known book -> leave untouched

    const preamble = words.slice(0, words.length - hit.take);
    const pre = preamble.length ? preamble.join(' ') + ' ' : '';

    return `${pre}${hit.say} ${conn.chapter} ${sayNum(conn, chap)} ${speakVerses(conn, v1, v2, rest)}`;
  });
}

const BARE_REF_RE =
  /(?<![\p{L}\d:])(\d+):(\d+)(?:\s*[-–—]\s*(\d+))?((?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)+)?(?![:\d])/giu;

export function expandBareReferences(text: string, conn: Connectives): string {
  return text.replace(BARE_REF_RE, (_m, chap, v1, v2, rest) =>
    `${conn.chapter} ${sayNum(conn, chap)} ${speakVerses(conn, v1, v2, rest)}`,
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
    p2 ? `${conn.pages} ${sayNum(conn, p1)} ${conn.through} ${sayNum(conn, p2)}` : `${conn.page} ${sayNum(conn, p1)}`,
  );
}

// "ch. 38" -> "chapter 38", "chs. 6-9" -> "chapters 6 through 9". The plural
// abbreviations (chs./chaps.) or a range/list force the plural label.
const CHAPTER_RE =
  /\bch(s|ap|aps)?\.\s*(\d+)(?:\s*[-–—]\s*(\d+))?((?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)+)?/gi;

export function expandChapters(text: string, conn: Connectives): string {
  return text.replace(CHAPTER_RE, (_m, suffix, c1, c2, rest) => {
    const plural = (suffix ?? '').toLowerCase().endsWith('s');
    return speakNumbers(conn, conn.chapter, conn.chapters, c1, c2, rest, plural);
  });
}

// A parenthesized bare number range — "(42 – 45)" — is a chapter/section
// reference in commentary prose; read the dash as "through" (or "and" when
// consecutive) rather than letting TTS voice the punctuation.
const PAREN_RANGE_RE = /\((\d+)\s*[-–—]\s*(\d+)\)/g;

export function expandParenRanges(text: string, conn: Connectives): string {
  return text.replace(PAREN_RANGE_RE, (_m, a, b) => `(${sayNum(conn, a)} ${rangeJoin(conn, a, b)} ${sayNum(conn, b)})`);
}

// "1 and 2 Samuel" -> "first and second Samuel". The digits are book numbers,
// not chapters; both expand against the shared numbered-book name. Only rewritten
// when both ordinals form a known book ("1 Samuel" and "2 Samuel" both exist).
export function expandPairedBooks(text: string, books: Map<string, string>, conn: Connectives): string {
  const re = new RegExp(
    `(?<![\\p{L}\\d])([123]|i{1,3})\\s+${escapeRe(conn.and)}\\s+([123]|i{1,3})\\s+(\\p{L}[\\p{L}.]*)`,
    'giu',
  );
  return text.replace(re, (match, n1, n2, bookWord) => {
    const a1 = ROMAN[n1.toLowerCase()] ?? n1;
    const a2 = ROMAN[n2.toLowerCase()] ?? n2;
    const hit1 = matchBook(books, a1, [bookWord]);
    const hit2 = matchBook(books, a2, [bookWord]);
    if (!hit1 || !hit2) return match;
    return `${hit1.say.split(' ')[0]} ${conn.and} ${hit2.say}`;
  });
}

// A book reference with a chapter (or chapter range/list) and no verse — "Gen
// 24", "2 Sam 11", "Luke 1 – 2", "1 Sam 1 – 2". Only rewritten when the leading
// words are a known book. No "chapter" label is inserted, matching how these are
// spoken ("Genesis twenty four", "Luke one and two"). Verse refs (Luke 1:2),
// which carry a colon, are handled earlier and excluded by the trailing guard.
const BOOK_REF_RE =
  /(?<![\p{L}\d])(?:([123]|i{1,3})(?![\p{L}])\s*)?((?:\p{L}[\p{L}.]*)(?:\s+\p{L}[\p{L}.]*){0,2})\s+(\d+)(?:\s*[-–—]\s*(\d+))?((?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)+)?(?![:\d])/giu;

export function expandBookRefs(text: string, books: Map<string, string>, conn: Connectives): string {
  return text.replace(BOOK_REF_RE, (match, num, wordsRaw, c1, c2, rest) => {
    const numArabic = num ? (ROMAN[num.toLowerCase()] ?? num) : '';
    const words = wordsRaw.trim().split(/\s+/);
    const hit = matchBook(books, numArabic, words);
    if (!hit) return match;

    // Without a verse or range a lone "Book N" is weakly signalled, so require
    // the book word to be capitalized — references are; prose nouns ("job 1")
    // usually aren't.
    if (!/^\p{Lu}/u.test(words[words.length - hit.take])) return match;

    const preamble = words.slice(0, words.length - hit.take);
    const pre = preamble.length ? preamble.join(' ') + ' ' : '';
    return `${pre}${hit.say} ${joinList(conn, spokenParts(conn, c1, c2, rest))}`;
  });
}

// A numbered book named on its own, with no chapter/verse following — "2 Samuel"
// in prose. The leading digit is part of the name, so it must read as the book's
// ordinal ("segundo samuel") rather than a counted "two". Only rewritten when the
// number+word(s) form a known numbered book and the word is capitalized, and only
// when no chapter digit follows (those are handled by the reference passes above).
const BARE_BOOK_RE =
  /(?<![\p{L}\d])([123]|i{1,3})(?![\p{L}])\s+((?:\p{L}[\p{L}.]*)(?:\s+\p{L}[\p{L}.]*){0,1})(?![\p{L}])(?!\s*\d)/giu;

export function expandBareBooks(text: string, books: Map<string, string>, conn: Connectives): string {
  return text.replace(BARE_BOOK_RE, (match, num, wordsRaw) => {
    const numArabic = ROMAN[num.toLowerCase()] ?? num;
    const words = wordsRaw.trim().split(/\s+/);
    if (!/^\p{Lu}/u.test(words[words.length - 1])) return match;
    const hit = matchBook(books, numArabic, words);
    if (!hit) return match;
    const preamble = words.slice(0, words.length - hit.take);
    const pre = preamble.length ? preamble.join(' ') + ' ' : '';
    return `${pre}${hit.say}`;
  });
}

// A bare chapter/verse range that follows a label already spelled out in the
// text — "chapters 42 – 45" — needs only its dash voiced as "through"/"and".
export function expandLabeledRanges(text: string, conn: Connectives): string {
  const labels = [conn.chapters, conn.chapter, conn.verses, conn.verse]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');
  const re = new RegExp(`\\b(${labels})\\s+(\\d+)\\s*[-–—]\\s*(\\d+)`, 'giu');
  return text.replace(re, (_m, label, a, b) => `${label} ${sayNum(conn, a)} ${rangeJoin(conn, a, b)} ${sayNum(conn, b)}`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A standalone number, possibly with grouping/decimal separators: "5", "1,000",
// "3.14". Bounded by non-alphanumerics so "1st", "h2o" or version-like "v1.5"
// fragments aren't touched.
const NUMBER_RE = /(?<![\p{L}\d.,])\d+(?:[.,]\d+)*(?![\p{L}\d])/gu;

// Spell out one number token. A 1-2 digit trailing group after the last
// separator is read as a decimal ("3.14" -> "three point one four"); anything
// else is treated as digit grouping and dropped ("1,000" -> "one thousand").
function spellNumber(token: string, conn: Connectives): string {
  const dec = token.match(/[.,](\d{1,2})$/);
  const intRaw = dec ? token.slice(0, -dec[0].length) : token;
  const intDigits = intRaw.replace(/[.,]/g, '');
  if (!intDigits) return token;
  const n = parseInt(intDigits, 10);
  let out = numberToWords(n, conn.lang);
  if (n > 999_999_999) return token;
  if (dec) {
    const frac = dec[1].split('').map(d => numberToWords(parseInt(d, 10), conn.lang)).join(' ');
    out += ` ${conn.point} ${frac}`;
  }
  return out;
}

// Spell out every remaining bare number so the TTS never has to guess — important
// when the language wasn't detected and the engine would read digits arbitrarily.
export function expandNumbers(text: string, conn: Connectives): string {
  return text.replace(NUMBER_RE, m => spellNumber(m, conn));
}

// Whole-word, case-sensitive acronym expansion (uppercase NVI matches; lowercase
// words don't). Longest terms first so e.g. "NKJV" beats "KJV".
export function expandAcronyms(text: string, acronyms: IAcronym[]): string {
  if (!acronyms.length) return text;
  const sorted = [...acronyms].sort((a, b) => b.term.length - a.term.length);
  const say = new Map(sorted.map(a => [a.term, a.say]));
  // Word terms get letter/digit boundaries so "NVI" doesn't fire inside "NVIS"
  // (lookarounds, not \b, so terms ending in a period like "e.g." still match
  // before a space or comma). Symbol terms ("=") carry no alphanumerics, so they
  // need no boundary and match even when glued to text ("x=5").
  const isWord = (t: string) => /[\p{L}\d]/u.test(t[0]) || /[\p{L}\d]/u.test(t[t.length - 1]);
  const words = sorted.filter(a => isWord(a.term)).map(a => escapeRe(a.term));
  const symbols = sorted.filter(a => !isWord(a.term)).map(a => escapeRe(a.term));
  const parts: string[] = [];
  if (words.length) parts.push(`(?<![\\p{L}\\d])(?:${words.join('|')})(?![\\p{L}\\d])`);
  if (symbols.length) parts.push(`(?:${symbols.join('|')})`);
  const re = new RegExp(parts.join('|'), 'gu');
  // Symbol terms can be glued to text ("x=5"), so pad their spoken form with
  // spaces ("x equals 5") and collapse the doubles a word term already separated.
  return text
    .replace(re, m => (isWord(m) ? (say.get(m) ?? m) : ` ${say.get(m) ?? m} `))
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Rewrite text into a more speakable form for TTS. Read-time only — never mutate
// stored OCR/edited text. Falls back to English tables for unknown languages.
export async function normalizeForSpeech(text: string, language: string): Promise<string> {
  if (!text) return text;
  const lang = effectiveLang(language);
  // Consume explicit abbreviations (pp./vv./ch.) before the generic book-range
  // matcher, so "pp. 119-176" reads as pages, not the "pp" Philippians alias.
  let out = expandReferences(text, BIBLE_BOOKS[lang], CONNECTIVES[lang]);
  out = expandVerseRefs(out, CONNECTIVES[lang]);
  out = expandPages(out, CONNECTIVES[lang]);
  out = expandChapters(out, CONNECTIVES[lang]);
  out = expandPairedBooks(out, BIBLE_BOOKS[lang], CONNECTIVES[lang]);
  out = expandBookRefs(out, BIBLE_BOOKS[lang], CONNECTIVES[lang]);
  out = expandBareBooks(out, BIBLE_BOOKS[lang], CONNECTIVES[lang]);
  out = expandBareReferences(out, CONNECTIVES[lang]);
  out = expandLabeledRanges(out, CONNECTIVES[lang]);
  out = expandParenRanges(out, CONNECTIVES[lang]);
  out = expandAcronyms(out, await getAcronyms(lang));
  // Last: any number the reference passes didn't touch is plain prose — spell it
  // out too so nothing is left as digits for the TTS to guess at.
  out = expandNumbers(out, CONNECTIVES[lang]);
  return out;
}
