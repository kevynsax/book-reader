// Split normalized text into sentence-sized units for per-sentence TTS and the
// read-along timeline. Heuristic — over/under-splitting only affects highlight
// granularity, never audio correctness.

const MAX_LEN = 600;

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

export function splitIntoSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const trimmed = para.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    // Split after sentence-ending punctuation followed by whitespace.
    for (const part of trimmed.split(/(?<=[.!?…])\s+/)) {
      const s = part.trim();
      if (!s) continue;
      if (s.length <= MAX_LEN) out.push(s);
      else out.push(...splitLong(s, MAX_LEN));
    }
  }
  return out;
}
