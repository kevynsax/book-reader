import fs from 'fs/promises';
import {
  QWENVL_SERVERS, QWENVL_MAX_TOKENS,
  SLM_API, SLM_API_FALLBACK, SLM_MODEL, SLM_SERVERS,
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

// Parse the SLM's multi-way split: a JSON array of sentence strings, or an object
// wrapping one under `parts`/`sentences`. Empties are dropped; null if none remain.
function parseSplitParts(raw: string): string[] | null {
  const text = stripMarkdownFence(raw.trim());
  const parsed =
    (() => { try { return JSON.parse(text); } catch { return extractLooseJson(text); } })();
  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object'
        ? ((parsed as Record<string, unknown>).parts ?? (parsed as Record<string, unknown>).sentences)
        : null);
  if (!Array.isArray(arr)) return null;
  const parts = arr
    .filter((s): s is string => typeof s === 'string')
    .map(s => sanitizePageText(s).trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
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

// One-off calls (title, language, table of contents) aren't load-balanced per
// page, but still try every configured server in order so a dead primary (e.g.
// a 502) falls back to a healthy one before surfacing an error to the user.
async function callQwenWithFallback(systemPrompt: string, userContent: unknown[]): Promise<string> {
  const servers = QWENVL_SERVERS;
  if (servers.length === 0) throw new Error('No QwenVL servers configured (set QWENVL_SERVERS)');
  let lastErr: unknown;
  for (const s of servers) {
    try {
      return await callQwen(systemPrompt, userContent, s.url, s.model);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// SLM endpoints support two dispatch modes against the configured servers:
//
//  - 'balance': route each call to the server with the least in-flight work
//    relative to its weight, falling back to the others when the chosen one
//    throws. Used by the bulk typo scan, where many lines fire in parallel. A
//    low-weight server (e.g. the slow Mac fallback) only gets a job once the
//    higher-weight server is saturated, so it never bottlenecks the batch.
//  - 'race': hit every server at once and take the first 2xx, aborting the rest.
//    Used by the one-at-a-time line review/split, where the goal is low latency
//    for a single request. Capped by a timeout so a stuck server can't stall it.
const SLM_RACE_TIMEOUT_MS = 10_000;

type SlmMode = 'balance' | 'race';

function slmBases(): string[] {
  return [...new Set([SLM_API, SLM_API_FALLBACK].filter(Boolean).map(b => b.replace(/\/+$/, '')))];
}

// Live count of requests currently in flight per server, used to spread bulk
// work by least relative load (inFlight / weight).
const slmInFlight = new Map<string, number>();
const slmLoad = (url: string) => slmInFlight.get(url) ?? 0;

// Servers ordered cheapest-first by current relative load, so the highest-weight
// (fastest) server is preferred until it fills up.
function balancedServers(): { url: string; weight: number }[] {
  return [...SLM_SERVERS].sort((a, b) => slmLoad(a.url) / a.weight - slmLoad(b.url) / b.weight);
}

async function slmFetchOne(base: string, path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`${base}${path}`, { ...init, signal });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(err || `SLM API returned ${res.status}`);
  }
  return res;
}

async function balanceFetch(path: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  const servers = balancedServers();
  if (servers.length === 0) throw new Error('No SLM servers configured (set SLM_API)');
  let lastErr: unknown;
  for (const { url } of servers) {
    slmInFlight.set(url, slmLoad(url) + 1);
    try {
      const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
      return await slmFetchOne(url, path, init, signal);
    } catch (err) {
      lastErr = err;
    } finally {
      slmInFlight.set(url, Math.max(0, slmLoad(url) - 1));
    }
  }
  throw lastErr;
}

async function raceFetch(path: string, init: RequestInit, timeoutMs = SLM_RACE_TIMEOUT_MS): Promise<Response> {
  const bases = slmBases();
  if (bases.length === 0) throw new Error('No SLM servers configured (set SLM_API)');

  const controllers = bases.map(() => new AbortController());
  const timer = setTimeout(() => controllers.forEach(c => c.abort()), timeoutMs);

  const attempts = bases.map(async (base, i) => ({ res: await slmFetchOne(base, path, init, controllers[i].signal), i }));

  try {
    const { res, i } = await Promise.any(attempts);
    controllers.forEach((c, j) => { if (j !== i) c.abort(); });
    return res;
  } catch (err) {
    if (err instanceof AggregateError) throw err.errors[err.errors.length - 1] ?? err.errors[0] ?? err;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function slmFetch(path: string, init: RequestInit, mode: SlmMode = 'balance', timeoutMs?: number): Promise<Response> {
  return mode === 'race' ? raceFetch(path, init, timeoutMs) : balanceFetch(path, init, timeoutMs);
}

export async function fetchSlmModels(): Promise<{ id: string; label: string }[]> {
  const res = await slmFetch('/v1/models', {}, 'race', 5000);

  const data = await res.json() as { data?: unknown };
  const list = Array.isArray(data?.data) ? data.data : [];
  const models = list
    .map(item => item as Record<string, unknown>)
    .map(item => typeof item.id === 'string' ? item.id : typeof item.model === 'string' ? item.model : '')
    .filter(Boolean)
    .map(id => ({ id, label: id }));
  return models.length ? models : [{ id: SLM_MODEL, label: SLM_MODEL }];
}

async function callSlm(systemPrompt: string, userText: string, model = SLM_MODEL, mode: SlmMode = 'balance'): Promise<string> {
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
  }, mode);

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const content = data?.choices?.[0]?.message?.content ?? '';
  if (typeof content !== 'string') throw new Error('Empty response from SLM');
  return content.trim();
}

export async function extractBookTitle(coverImagePath: string): Promise<string> {
  const buffer = await fs.readFile(coverImagePath);
  const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

  const raw = await callQwenWithFallback(TITLE_SYSTEM_PROMPT, [
    { type: 'text', text: TITLE_PAGE_PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ]);

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
    'race',
  );
  return parseSplitLineSuggestion(raw);
}

// Ask the SLM to break one long sentence into as many complete, natural sentences
// as needed so each is at most `maxChars` characters — more than two is fine.
// Preserves language, meaning, entities, and reading order. Returns null when the
// model declines or errors (or yields a single piece, i.e. no real split).
export async function splitLineIntoParts(line: string, maxChars: number, model?: string): Promise<string[] | null> {
  const raw = await callSlm(
    [
      'You split a single long book sentence into several complete, natural, valid sentences for text-to-speech.',
      `Each output sentence must be at most ${maxChars} characters long.`,
      'Return one valid JSON array of strings and nothing else, e.g. ["First sentence.", "Second sentence."].',
      'Preserve the original language, meaning, named entities, and reading order exactly.',
      'Split only at natural sentence or clause boundaries; never split inside a word, number, or reference.',
      'Use as many pieces as needed so every piece is within the limit, but no more pieces than necessary.',
      'You may add or adjust only the minimal punctuation and capitalization needed to make each output a complete sentence.',
      'Do not summarize, translate, expand, omit meaning, add commentary, or use markdown.',
      'If the sentence cannot be split, return an array containing only the original sentence.',
    ].join(' '),
    line,
    model || SLM_MODEL,
    'race',
  );
  const parts = parseSplitParts(raw);
  return parts && parts.length > 1 ? parts : null;
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

  const raw = await callQwenWithFallback(LANG_SYSTEM_PROMPT, [
    { type: 'text', text: LANG_PAGE_PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ]);

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

  const raw = await callQwenWithFallback(TOC_SYSTEM_PROMPT, [
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
  summaryImagePaths: string[],
  ocrPages: { page: number; text: string }[],
): Promise<ChapterSuggestion[]> {
  // Read the contents from every summary page and merge, dropping duplicate
  // entries (same title + page) that can appear when pages overlap.
  const tocLists = await Promise.all(summaryImagePaths.map(p => extractTableOfContents(p)));
  const seen = new Set<string>();
  const toc: TocEntry[] = [];
  for (const entry of tocLists.flat()) {
    const key = `${entry.title.toLowerCase()}|${entry.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    toc.push(entry);
  }
  if (toc.length === 0) return [];

  const byPage = new Map(ocrPages.map(p => [p.page, p.text]));
  const orderedPages = ocrPages.map(p => p.page);
  return toc.map(entry => resolveLocation(entry, byPage, orderedPages));
}
