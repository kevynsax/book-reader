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

// Candidate needles for a TOC title, most likely-to-match first. TOC entries
// often carry leader dots / a trailing page number ("Introdução ...... 12") and
// a leading list/chapter marker ("3. ", "Capítulo IV — ") that the in-page
// heading does not, so we also try cleaned-up variants.
function titleNeedles(title: string): string[] {
  const needles: string[] = [];
  const add = (s: string) => { const v = s.trim(); if (v.length >= 2 && !needles.includes(v)) needles.push(v); };

  const full = title.trim();
  // Drop trailing leader dots and/or page number: "Intro . . . 12" -> "Intro".
  const noTail = full.replace(/[\s.·•–—-]*\d+\s*$/, '').replace(/[\s.·•]+$/, '').trim();
  // Drop a leading "3.", "IV -", "Chapter 2:", "Capítulo 1 —" style marker.
  const noHead = noTail.replace(/^\s*(chapter|cap[ií]tulo|part[e]?|secti?on|se[cç][aã]o)?\s*[\dIVXLCDM]+\s*[:.)\-—–]?\s*/i, '').trim();

  add(noTail);
  add(noHead);
  add(full);
  return needles;
}

// First char offset at which `title` appears in `text`, or -1. Matches the
// frontend's plain case-insensitive search, with an accent-folded fallback.
// toLowerCase/fold are length-preserving for normal text, so the index maps back
// to the original string.
function findTitleOffset(title: string, text: string): number {
  const lowText  = text.toLowerCase();
  const foldText = fold(text);
  for (const needle of titleNeedles(title)) {
    const direct = lowText.indexOf(needle.toLowerCase());
    if (direct >= 0) return direct;
    const folded = foldText.indexOf(fold(needle));
    if (folded >= 0) return folded;
  }
  return -1;
}

// Resolve a TOC entry to a real location in the scanned pages. The printed page
// number rarely equals the scanned page number (front-matter offset, two-up
// photocopies), so the printed page and its half are only *priority hints*: we
// then scan every page in order and take the first match — same leniency as the
// frontend search. Falls back to the printed page with offset 0 and found=false
// so the user only has to fix the page/char.
function resolveLocation(
  entry: TocEntry,
  byPage: Map<number, string>,
  orderedPages: number[],
): ChapterSuggestion {
  const half = Math.max(1, Math.round(entry.page / 2));
  const seen = new Set<number>();
  const order = [entry.page, half, ...orderedPages].filter(p => !seen.has(p) && seen.add(p));

  for (const page of order) {
    const text = byPage.get(page);
    if (text === undefined) continue;
    const offset = findTitleOffset(entry.title, text);
    if (offset >= 0) return { title: entry.title, page, startChar: offset, found: true };
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
  const orderedPages = ocrPages.map(p => p.page);
  return toc.map(entry => resolveLocation(entry, byPage, orderedPages));
}
