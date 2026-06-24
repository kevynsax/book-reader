import fs from 'fs/promises';
import {
  QWENVL_SERVERS, QWENVL_MAX_TOKENS,
  SLM_API, SLM_API_FALLBACK, SLM_MODEL,
  OCR_SYSTEM_PROMPT, OCR_PAGE_PROMPT,
  TITLE_SYSTEM_PROMPT, TITLE_PAGE_PROMPT,
  TOC_SYSTEM_PROMPT, TOC_PAGE_PROMPT,
  LANG_SYSTEM_PROMPT, LANG_PAGE_PROMPT,
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

export interface SplitLineSuggestion {
  left: string;
  right: string;
}

export interface LineReviewSuggestion {
  corrected: string;
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

function parseLineReviewSuggestion(raw: string): LineReviewSuggestion | null {
  const text = stripMarkdownFence(raw.trim());
  const parsed =
    (() => { try { return JSON.parse(text); } catch { return extractLooseJson(text); } })();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const corrected = (parsed as Record<string, unknown>).corrected;
  if (typeof corrected !== 'string') return null;
  const clean = sanitizePageText(corrected).trim();
  return clean ? { corrected: clean } : null;
}

function parseSplitLineSuggestion(raw: string): SplitLineSuggestion | null {
  const text = stripMarkdownFence(raw.trim());
  const parsed =
    (() => { try { return JSON.parse(text); } catch { return extractLooseJson(text); } })();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const left = (parsed as Record<string, unknown>).left;
  const right = (parsed as Record<string, unknown>).right;
  if (typeof left !== 'string' || typeof right !== 'string') return null;
  const cleanLeft = sanitizePageText(left).trim();
  const cleanRight = sanitizePageText(right).trim();
  if (!cleanLeft || !cleanRight) return null;
  return { left: cleanLeft, right: cleanRight };
}

// One-off calls (title, language, table of contents) aren't load-balanced per
// page, so they run on the first configured server.
function primaryServer(): { url: string; model: string } {
  const server = QWENVL_SERVERS[0];
  if (!server) throw new Error('No QwenVL servers configured (set QWENVL_SERVERS)');
  return server;
}

async function callQwen(systemPrompt: string, userContent: unknown[], baseUrl: string, model: string): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: QWENVL_MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const host = new URL(baseUrl).host;
    const body = (await res.text().catch(() => '')).trim();
    // Skip HTML bodies (e.g. nginx 502 pages) so the surfaced error stays readable.
    const detail = body && !body.startsWith('<') ? `: ${body.slice(0, 200)}` : '';
    throw new Error(`QwenVL ${host} returned ${res.status} ${res.statusText}${detail}`.trim());
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const content = data?.choices?.[0]?.message?.content ?? '';
  if (typeof content !== 'string') throw new Error('Empty response from Qwen');
  return content.trim();
}

// SLM endpoints. Calls are round-robined across the configured servers to spread
// load, and the remaining servers act as fallbacks when the chosen one throws
// (network error or non-2xx). A fresh AbortSignal is built per attempt so one
// server's timeout doesn't pre-cancel the next.
function slmBases(): string[] {
  return [...new Set([SLM_API, SLM_API_FALLBACK].filter(Boolean).map(b => b.replace(/\/+$/, '')))];
}

let slmCursor = 0;
function balancedBases(): string[] {
  const bases = slmBases();
  if (bases.length <= 1) return bases;
  const start = slmCursor++ % bases.length;
  return [...bases.slice(start), ...bases.slice(0, start)];
}

async function slmFetch(path: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  let lastErr: unknown;
  for (const base of balancedBases()) {
    try {
      const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
      const res = await fetch(`${base}${path}`, { ...init, signal });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(err || `SLM API returned ${res.status}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function fetchSlmModels(): Promise<{ id: string; label: string }[]> {
  const res = await slmFetch('/v1/models', {}, 5000);

  const data = await res.json() as { data?: unknown };
  const list = Array.isArray(data?.data) ? data.data : [];
  const models = list
    .map(item => item as Record<string, unknown>)
    .map(item => typeof item.id === 'string' ? item.id : typeof item.model === 'string' ? item.model : '')
    .filter(Boolean)
    .map(id => ({ id, label: id }));
  return models.length ? models : [{ id: SLM_MODEL, label: SLM_MODEL }];
}

async function callSlm(systemPrompt: string, userText: string, model = SLM_MODEL): Promise<string> {
  const res = await slmFetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 512,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
    }),
  });

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const content = data?.choices?.[0]?.message?.content ?? '';
  if (typeof content !== 'string') throw new Error('Empty response from SLM');
  return content.trim();
}

export async function extractBookTitle(coverImagePath: string): Promise<string> {
  const buffer = await fs.readFile(coverImagePath);
  const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

  const { url, model } = primaryServer();
  const raw = await callQwen(TITLE_SYSTEM_PROMPT, [
    { type: 'text', text: TITLE_PAGE_PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ], url, model);

  const text = stripMarkdownFence(raw.trim());
  const parsed =
    (() => { try { return JSON.parse(text); } catch { return extractLooseJson(text); } })();
  const title = (parsed as Record<string, unknown>)?.title;
  return typeof title === 'string' ? title.trim() : '';
}

export async function splitLineIntoSentences(line: string, model?: string): Promise<SplitLineSuggestion | null> {
  const raw = await callSlm(
    [
      'You split a single long book sentence into two complete, natural, valid sentences for text-to-speech review.',
      'Return one valid JSON object and nothing else.',
      'The JSON object must have this exact shape: {"left":"...","right":"..."}',
      'Preserve the original language, meaning, named entities, and reading order.',
      'Keep left and right close to the same character length whenever possible.',
      'Prefer a split point near the middle of the original line, but never at the cost of producing unnatural or invalid sentences.',
      'You may add or adjust only minimal punctuation and capitalization needed to make both outputs complete sentences.',
      'Do not summarize, translate, expand, omit meaning, add commentary, or use markdown.',
      'If the line cannot be split into two valid sentences, return {"left":"","right":""}.',
    ].join(' '),
    line,
    model || SLM_MODEL,
  );
  return parseSplitLineSuggestion(raw);
}

export async function reviewLineGrammar(line: string, model?: string): Promise<LineReviewSuggestion | null> {
  const raw = await callSlm(
    [
      'You proofread a single line from an OCR-extracted book for grammar mistakes and typos.',
      'Return one valid JSON object and nothing else.',
      'The JSON object must have this exact shape: {"corrected":"..."}',
      'Fix only clear spelling, OCR, and grammar errors.',
      'Preserve the original language, meaning, named entities, punctuation style, and reading order.',
      'Do not rephrase, restyle, translate, summarize, expand, split, merge, or change text that is already correct.',
      'Do not add commentary or markdown.',
      'If the line has no errors, return it unchanged in the "corrected" field.',
    ].join(' '),
    line,
    model || SLM_MODEL,
  );
  return parseLineReviewSuggestion(raw);
}

// Ask Qwen for the page's primary language once (e.g. from the summary page) so
// the whole book reads in one language instead of re-detecting per page.
export async function detectLanguage(imagePath: string): Promise<string> {
  const buffer = await fs.readFile(imagePath);
  const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

  const { url, model } = primaryServer();
  const raw = await callQwen(LANG_SYSTEM_PROMPT, [
    { type: 'text', text: LANG_PAGE_PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ], url, model);

  const text = stripMarkdownFence(raw.trim());
  const parsed =
    (() => { try { return JSON.parse(text); } catch { return extractLooseJson(text); } })();
  const language = (parsed as Record<string, unknown>)?.language;
  return typeof language === 'string' ? language.toLowerCase().trim() : 'unknown';
}

export async function ocrPage(imagePath: string, baseUrl: string, model: string): Promise<OcrResult> {
  const buffer = await fs.readFile(imagePath);
  const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

  const raw = await callQwen(OCR_SYSTEM_PROMPT, [
    { type: 'text', text: OCR_PAGE_PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ], baseUrl, model);

  return parseOcrResult(raw);
}

async function extractTableOfContents(imagePath: string): Promise<TocEntry[]> {
  const buffer = await fs.readFile(imagePath);
  const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

  const { url, model } = primaryServer();
  const raw = await callQwen(TOC_SYSTEM_PROMPT, [
    { type: 'text', text: TOC_PAGE_PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ], url, model);

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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Words of a chapter title are often broken across lines on the chapter's own
// title page ("As Epístolas\nAprendendo a Pensar\nContextualmente"), so match the
// words in order while allowing any whitespace/punctuation run between them.
const TITLE_SEP = '[\\s.·•–—:_-]+';

function titleRegex(needle: string): RegExp | null {
  const parts = needle.split(/[\s.·•–—:_-]+/).filter(Boolean).map(escapeRegex);
  if (parts.length === 0) return null;
  return new RegExp(parts.join(TITLE_SEP), 'i');
}

function findTitleOffset(title: string, text: string): number {
  const foldText = fold(text);
  for (const needle of titleNeedles(title)) {
    const direct = titleRegex(needle)?.exec(text);
    if (direct) return direct.index;
    // Accent-insensitive fallback. NFKD keeps positions for single-accent Latin
    // characters, so the index into the folded text maps back to the original.
    const folded = titleRegex(fold(needle))?.exec(foldText);
    if (folded) return folded.index;
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
