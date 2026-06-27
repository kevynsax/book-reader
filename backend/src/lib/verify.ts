// Compare what a TTS segment was asked to say against what Whisper heard. Whisper
// drops punctuation, lowercases, and normalizes spacing/diacritics, so the match
// is fuzzy: both sides are normalized to a bag of word tokens and scored by
// word-level edit distance.

// Lowercase, strip diacritics, drop punctuation/symbols, collapse whitespace, and
// split into word tokens. Digits are kept as-is (Whisper usually verbalizes them,
// but the threshold tolerates the occasional number mismatch).
export function normalizeWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Levenshtein distance between two token sequences (word-level).
function wordEditDistance(a: string[], b: string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// Word-level similarity in [0, 1]: 1 - (edit distance / longer length). Two empty
// strings count as a perfect match; one empty against a non-empty counts as 0.
export function wordSimilarity(expected: string, actual: string): number {
  const a = normalizeWords(expected);
  const b = normalizeWords(actual);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dist = wordEditDistance(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}
