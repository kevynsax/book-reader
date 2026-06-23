// Diff the reviewed page text against the speech-normalized text so the review
// UI can highlight what will actually be read. Normalization is regex-based and
// never adds/removes line breaks, so the two share line structure — we diff
// line-by-line and only word-diff lines that changed.

export interface DiffSeg {
  // The original (reviewed) text for this span.
  text: string;
  // The spoken replacement, or null when this span is read verbatim.
  read: string | null;
}

// Word-level diff. Reflow collapses intra-line whitespace to single spaces, so
// splitting on ' ' round-trips faithfully and avoids fragmenting a change across
// matched space tokens.
function diffLine(a: string, b: string): DiffSeg[] {
  if (a === b) return [{ text: a, read: null }];

  const at = a.split(' ');
  const bt = b.split(' ');
  const n = at.length;
  const m = bt.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = at[i] === bt[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Ordered items: an equal word, or a change block (deleted/inserted words).
  type Item = { eq: string } | { del: string[]; ins: string[] };
  const items: Item[] = [];
  let i = 0;
  let j = 0;
  let del: string[] = [];
  let ins: string[] = [];
  const flush = () => {
    if (del.length || ins.length) { items.push({ del, ins }); del = []; ins = []; }
  };

  while (i < n && j < m) {
    if (at[i] === bt[j]) {
      flush();
      items.push({ eq: at[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      del.push(at[i]); i++;
    } else {
      ins.push(bt[j]); j++;
    }
  }
  while (i < n) { del.push(at[i]); i++; }
  while (j < m) { ins.push(bt[j]); j++; }
  flush();

  const segs: DiffSeg[] = [];
  items.forEach((it, idx) => {
    if (idx > 0) segs.push({ text: ' ', read: null });
    if ('eq' in it) segs.push({ text: it.eq, read: null });
    else segs.push({ text: it.del.join(' '), read: it.ins.join(' ') });
  });
  return segs;
}

export function diffText(original: string, read: string): DiffSeg[] {
  const a = original.split('\n');
  const b = read.split('\n');
  if (a.length !== b.length) return [{ text: original, read: null }];

  const out: DiffSeg[] = [];
  a.forEach((line, idx) => {
    out.push(...diffLine(line, b[idx]));
    if (idx < a.length - 1) out.push({ text: '\n', read: null });
  });
  return out;
}
