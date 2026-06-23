// Phase 1 (post-OCR): reflow page text so one line == one sentence, unwrapping
// mid-sentence hard breaks. Phase 2 (generation) then trusts those line breaks.
// Heuristic — over/under-splitting only affects highlight granularity, never
// audio correctness.

const MAX_LEN = 600;

// A short bracketed aside is kept whole and glued to the sentence it follows,
// rather than split into its own sentence.
const BRACKET_KEEP_MAX = 120;

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const ENDERS = /[.!?…]/;
const CLOSERS = /["'”’)\]}]/;

// Reference abbreviations whose trailing period is not a sentence end — they are
// almost always followed by a number ("ch. 38", "vv. 6-9") and must stay glued.
const ABBREVS = ['ch', 'chap', 'chaps', 'chs', 'v', 'vv', 'vs', 'p', 'pp', 'cf', 'vol', 'vols', 'esp', 'ff'];
const ABBREV_END = new RegExp(`(?:^|[\\s(\\[])(?:${ABBREVS.join('|')})\\.$`, 'i');

function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

// Break an over-long sentence on clause punctuation, then by hard length.
function splitLong(s: string, max: number): string[] {
  const grouped: string[] = [];
  let buf = '';
  for (const piece of s.split(/(?<=[,;:])\s+/)) {
    if (buf && (buf + ' ' + piece).length > max) {
      grouped.push(buf.trim());
      buf = piece;
    } else {
      buf = buf ? buf + ' ' + piece : piece;
    }
  }
  if (buf.trim()) grouped.push(buf.trim());
  return grouped.flatMap(x => (x.length <= max ? [x] : hardSplit(x, max)));
}

// Cap a sentence at MAX_LEN for TTS safety, splitting on clause punctuation.
export function splitLongSentence(s: string): string[] {
  return s.length <= MAX_LEN ? [s] : splitLong(s, MAX_LEN);
}

// A title is a short standalone line — at most `maxWords` words. Used to pad
// silence around chapter/section headings during assembly.
export function isTitle(text: string, maxWords = 5): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= maxWords;
}

// From an opening bracket at `start`, return the balanced group, its inner text,
// and the index past the closing bracket — or null if unbalanced before the end.
function captureBracket(text: string, start: number): { full: string; inner: string; end: number } | null {
  const stack: string[] = [];
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (OPENERS[ch]) {
      stack.push(OPENERS[ch]);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack[stack.length - 1] !== ch) return null;
      stack.pop();
      if (stack.length === 0) {
        return { full: text.slice(start, i + 1), inner: text.slice(start + 1, i), end: i + 1 };
      }
    }
  }
  return null;
}

// Split a single paragraph (already whitespace-collapsed) into sentences. Short
// bracketed groups are never split internally and, when they sit at a boundary,
// stay attached to the preceding sentence.
function splitParagraph(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (OPENERS[ch]) {
      const grp = captureBracket(text, i);
      if (grp && grp.inner.length < BRACKET_KEEP_MAX) {
        buf += grp.full;
        i = grp.end;
        continue;
      }
    }

    if (ch === '.' && ABBREV_END.test(buf + ch)) {
      buf += ch;
      i++;
      continue;
    }

    if (ENDERS.test(ch)) {
      buf += ch;
      i++;
      while (i < text.length && CLOSERS.test(text[i])) { buf += text[i]; i++; }

      if (i >= text.length || /\s/.test(text[i])) {
        let k = i;
        while (k < text.length && /\s/.test(text[k])) k++;
        // A short aside right after the boundary glues to this sentence.
        if (k < text.length && OPENERS[text[k]]) {
          const grp = captureBracket(text, k);
          if (grp && grp.inner.length < BRACKET_KEEP_MAX) {
            buf += ' ' + grp.full;
            out.push(buf.trim());
            buf = '';
            i = grp.end;
            continue;
          }
        }
        if (buf.trim()) out.push(buf.trim());
        buf = '';
        i = k;
        continue;
      }
      continue;
    }

    buf += ch;
    i++;
  }

  if (buf.trim()) out.push(buf.trim());
  return out;
}

// Reflow OCR'd page text into a sentence-per-line form: paragraphs (blank-line
// separated) are preserved, hard-wrapped lines inside a paragraph are unwrapped,
// and each sentence ends up on its own line for review before generation.
export function reflowSentences(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(para => {
      const joined = para.replace(/\s+/g, ' ').trim();
      if (!joined) return '';
      return splitParagraph(joined).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}
