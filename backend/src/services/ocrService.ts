import fs from 'fs/promises';
import {
  QWENVL_API, QWENVL_MODEL, QWENVL_MAX_TOKENS,
  OCR_SYSTEM_PROMPT, OCR_PAGE_PROMPT,
  TOC_SYSTEM_PROMPT, TOC_PAGE_PROMPT,
} from '../config.js';

interface OcrResult {
  language: string;
  content: string;
}

export interface ChapterSuggestion {
  title: string;
  page: number;       // resolved start page in the scanned reading range
  startChar: number;  // char offset of the heading within that page's text
  found: boolean;     // whether the title was actually located in the OCR text
}

interface TocEntry {
  title: string;
  page: number;       // page number as printed in the table of contents
}

function stripMarkdownFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function extractLooseJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function parseOcrResult(raw: string): OcrResult {
  const text = stripMarkdownFence(raw.trim());
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        language: typeof parsed.language === 'string' ? parsed.language.toLowerCase() : 'unknown',
        content: typeof parsed.content === 'string' ? parsed.content.trim() : '',
      };
    }
  } catch {
    const loose = extractLooseJson(text);
    if (loose && typeof loose === 'object' && !Array.isArray(loose)) {
      const l = loose as Record<string, unknown>;
      return {
        language: typeof l.language === 'string' ? l.language.toLowerCase() : 'unknown',
        content: typeof l.content === 'string' ? (l.content as string).trim() : '',
      };
    }
  }
  return { language: 'unknown', content: text };
}

function parseTocEntries(raw: string): TocEntry[] {
  const text = stripMarkdownFence(raw.trim());
  const arr =
    (() => { try { const p = JSON.parse(text); return Array.isArray(p) ? p : null; } catch { return null; } })()
    ?? (() => { const l = extractLooseJson(text); return Array.isArray(l) ? (l as unknown[]) : null; })();

  if (!arr) return [];
  return arr
    .map(item => item as Record<string, unknown>)
    .filter(i => typeof i?.title === 'string' && typeof i?.page === 'number')
    .map(i => ({ title: (i.title as string).trim(), page: i.page as number }))
    .filter(e => e.title.length > 0);
}

async function callQwen(systemPrompt: string, userContent: unknown[]): Promise<string> {
  const res = await fetch(`${QWENVL_API}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWENVL_MODEL,
      temperature: 0,
      max_tokens: QWENVL_MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(err || `Qwen API returned ${res.status}`);
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const content = data?.choices?.[0]?.message?.content ?? '';
  if (typeof content !== 'string') throw new Error('Empty response from Qwen');
  return content.trim();
}

export async function ocrPage(imagePath: string): Promise<OcrResult> {
  const buffer = await fs.readFile(imagePath);
  const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

  const raw = await callQwen(OCR_SYSTEM_PROMPT, [
    { type: 'text', text: OCR_PAGE_PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ]);

  return parseOcrResult(raw);
}

// Ask Qwen to read the table-of-contents image and return the listed chapters
// with their printed page numbers. Only a single image is sent, so this never
// approaches the model's context limit (unlike dumping the whole book's text).
async function extractTableOfContents(imagePath: string): Promise<TocEntry[]> {
  const buffer = await fs.readFile(imagePath);
  const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

  const raw = await callQwen(TOC_SYSTEM_PROMPT, [
    { type: 'text', text: TOC_PAGE_PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ]);

  return parseTocEntries(raw);
}

// Length-preserving lowercase + accent fold, so a match index maps back to the
// original text 1:1 (used to compute the chapter's startChar).
function fold(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Candidate needles for a TOC title, most specific first. The second drops a
// leading "Chapter 3", "Capítulo IV", "Part 2" style prefix so a bare in-page
// heading ("The Awakening") still matches a decorated TOC entry.
function titleNeedles(title: string): string[] {
  const t = title.trim();
  const stripped = t.replace(/^\s*(chapter|cap[ií]tulo|part[e]?|secti?on|se[cç][aã]o)\s+[\dIVXLCDM]+\s*[:.\-—–]?\s*/i, '').trim();
  return stripped && stripped !== t ? [t, stripped] : [t];
}

// First char offset at which `title` appears in `text`, or -1. Folds accents and
// case but keeps indices aligned with the original string (NFKD on the haystack
// can shift indices, so we fold the haystack lazily per candidate length).
function findTitleOffset(title: string, text: string): number {
  for (const needle of titleNeedles(title)) {
    if (needle.length < 2) continue;
    const foldedNeedle = fold(needle);
    // Slide a same-length window so the returned index is into the ORIGINAL text.
    for (let i = 0; i + needle.length <= text.length; i++) {
      if (fold(text.slice(i, i + needle.length)) === foldedNeedle) return i;
    }
  }
  return -1;
}

// Resolve a TOC entry to a real location in the scanned pages. Tries the printed
// page, then its half (books photocopied two-up land the printed page on ~page/2),
// then any page that uniquely contains the title. Falls back to the printed page
// with offset 0 and found=false so the user only has to fix the page/char.
function resolveLocation(
  entry: TocEntry,
  byPage: Map<number, string>,
): ChapterSuggestion {
  const half = Math.max(1, Math.round(entry.page / 2));
  const candidates = entry.page === half ? [entry.page] : [entry.page, half];

  for (const page of candidates) {
    const text = byPage.get(page);
    if (text === undefined) continue;
    const offset = findTitleOffset(entry.title, text);
    if (offset >= 0) return { title: entry.title, page, startChar: offset, found: true };
  }

  // Last resort: a page anywhere in the range that uniquely contains the title.
  const hits: { page: number; offset: number }[] = [];
  for (const [page, text] of byPage) {
    const offset = findTitleOffset(entry.title, text);
    if (offset >= 0) hits.push({ page, offset });
    if (hits.length > 1) break;
  }
  if (hits.length === 1) {
    return { title: entry.title, page: hits[0].page, startChar: hits[0].offset, found: true };
  }

  return { title: entry.title, page: entry.page, startChar: 0, found: false };
}

// Detect chapters from the table-of-contents page image, then locate each one in
// the OCR'd reading range. `summaryImagePath` is the page the user chose as the
// contents page; `ocrPages` is the OCR'd reading range (text already sanitized).
export async function detectChapters(
  summaryImagePath: string,
  ocrPages: { page: number; text: string }[],
): Promise<ChapterSuggestion[]> {
  const toc = await extractTableOfContents(summaryImagePath);
  if (toc.length === 0) return [];

  const byPage = new Map(ocrPages.map(p => [p.page, p.text]));
  return toc.map(entry => resolveLocation(entry, byPage));
}
