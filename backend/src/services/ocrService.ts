import fs from 'fs/promises';
import {
  QWENVL_API, QWENVL_MODEL, QWENVL_MAX_TOKENS,
  OCR_SYSTEM_PROMPT, OCR_PAGE_PROMPT,
  CHAPTER_SYSTEM_PROMPT,
} from '../config.js';

interface OcrResult {
  language: string;
  content: string;
}

interface ChapterSuggestion {
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
  return { language: 'unknown', content: text };
}

function parseChapters(raw: string): ChapterSuggestion[] {
  const text = stripMarkdownFence(raw.trim());
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed
        .filter(item => typeof item?.title === 'string' && typeof item?.page === 'number')
        .map(item => ({ title: item.title as string, page: item.page as number }));
    }
  } catch {
    const loose = extractLooseJson(text);
    if (Array.isArray(loose)) {
      return (loose as unknown[])
        .filter(item => typeof (item as Record<string, unknown>)?.title === 'string')
        .map(item => {
          const i = item as Record<string, unknown>;
          return { title: i.title as string, page: typeof i.page === 'number' ? i.page : 1 };
        });
    }
  }
  return [];
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

export async function detectChapters(
  ocrPages: { page: number; text: string }[]
): Promise<ChapterSuggestion[]> {
  const combinedText = ocrPages
    .map(p => `=== Page ${p.page} ===\n${p.text}`)
    .join('\n\n');

  const raw = await callQwen(CHAPTER_SYSTEM_PROMPT, [
    {
      type: 'text',
      text: `Here is the book text. Identify all chapter titles and the page where each starts:\n\n${combinedText}`,
    },
  ]);

  return parseChapters(raw);
}
