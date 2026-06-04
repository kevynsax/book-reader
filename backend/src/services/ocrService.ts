import fs from 'fs/promises';
import {
  QWENVL_API, QWENVL_MODEL, QWENVL_MAX_TOKENS,
  OCR_SYSTEM_PROMPT, OCR_PAGE_PROMPT,
  TITLE_SYSTEM_PROMPT, TITLE_PAGE_PROMPT,
  TOC_SYSTEM_PROMPT, TOC_PAGE_PROMPT,
} from '../config.js';
import { sanitizePageText } from '../lib/sanitize.js';

interface OcrResult {
  language: string;
  content: string;
}

export interface ChapterSuggestion {
  title: string;
  page: number;
  startChar: number;
  found: boolean;
}

interface TocEntry {
  title: string;
  page: number;
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
  return { language: 'unknown', content: sanitizePageText(text) };
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

export async function extractBookTitle(coverImagePath: string): Promise<string> {
  const buffer = await fs.readFile(coverImagePath);
  const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

  const raw = await callQwen(TITLE_SYSTEM_PROMPT, [
    { type: 'text', text: TITLE_PAGE_PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ]);

  const text = stripMarkdownFence(raw.trim());
  const parsed =
    (() => { try { return JSON.parse(text); } catch { return extractLooseJson(text); } })();
  const title = (parsed as Record<string, unknown>)?.title;
  return typeof title === 'string' ? title.trim() : '';
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

async function extractTableOfContents(imagePath: string): Promise<TocEntry[]> {
  const buffer = await fs.readFile(imagePath);
  const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

  const raw = await callQwen(TOC_SYSTEM_PROMPT, [
    { type: 'text', text: TOC_PAGE_PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ]);

  return parseTocEntries(raw);
}

function fold(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function titleNeedles(title: string): string[] {
  const needles: string[] = [];
  const add = (s: string) => { const v = s.trim(); if (v.length >= 2 && !needles.includes(v)) needles.push(v); };

  const full = title.trim();
  const noTail = full.replace(/[\s.·•–—-]*\d+\s*$/, '').replace(/[\s.·•]+$/, '').trim();
  const noHead = noTail.replace(/^\s*(chapter|cap[ií]tulo|part[e]?|secti?on|se[cç][aã]o)?\s*[\dIVXLCDM]+\s*[:.)\-—–]?\s*/i, '').trim();

  add(noTail);
  add(noHead);
  add(full);
  return needles;
}

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
