import dotenv from 'dotenv';
dotenv.config();

export const PORT = parseInt(process.env.PORT || '3001');
export const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/book-reader';
export const QWENVL_API = process.env.QWENVL_API || 'https://qwenvl.kevyn.com.br';
export const QWENVL_MODEL = process.env.QWENVL_MODEL || 'Qwen/Qwen2.5-VL-7B-Instruct-AWQ';
export const TTS_API = process.env.TTS_API || 'http://127.0.0.1:8000';

// TTS servers run the same OpenAI-compatible API (see ../tts-2). Each loads one
// model at a time but can hot-swap. Synthesis is load-balanced across them.
// Configure via TTS_SERVERS: "id|Label|url" entries, comma- or newline-separated.
export interface TtsServerConfig { id: string; label: string; url: string; }

function parseServers(): TtsServerConfig[] {
  const raw = (process.env.TTS_SERVERS || '').trim();
  if (raw) {
    const parsed = raw
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(entry => {
        const [id, label, url] = entry.split('|').map(x => x.trim());
        return { id, label: label || id, url: (url || '').replace(/\/+$/, '') };
      })
      .filter(s => s.id && s.url);
    if (parsed.length) return parsed;
  }
  return [{ id: 'macbook', label: 'MacBook', url: TTS_API.replace(/\/+$/, '') }];
}

export const TTS_SERVERS: TtsServerConfig[] = parseServers();
export const DATA_DIR = process.env.DATA_DIR || './data';
export const DEFAULT_VOICE = process.env.TTS_VOICE || 'chatterbox:pt-BR-FranciscaNeural';
export const TTS_SPEED = parseFloat(process.env.TTS_SPEED || '1.0');
export const DEFAULT_LANGUAGE = process.env.TTS_LANGUAGE || 'en';
export const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

export const QWENVL_MAX_TOKENS = 4096;

export const OCR_SYSTEM_PROMPT = [
  'You are a document OCR and transcription engine.',
  'Return one valid JSON object and nothing else.',
  'The JSON object must have this exact shape: {"language":"pt","content":"..."}',
  'Use language as a lowercase ISO 639-1 code such as "pt", "en", "es", or "unknown".',
  'Escape quotes and line breaks inside content so the response remains valid JSON.',
  'Never add explanations, summaries, references, citations, commentary, confidence notes, markdown fences, or greetings.',
].join(' ');

export const OCR_PAGE_PROMPT = [
  'Extract the document text for text-to-speech.',
  'Detect the primary language of the main content.',
  'Put only the main readable body content in the JSON content field, in the same language as the file.',
  'Preserve the original reading order: title, headings, paragraphs, lists, and quoted text.',
  'Ignore page numbers, running headers, running footers, footnotes, references, copyright notices, scanner marks, watermarks, and decorative text.',
  'Ignore superscript footnote markers, whether they are numbers, letters, or symbols placed beside words.',
  'Do not include footnote text, endnote text, bibliography entries, reference lists, or citation-only notes.',
  'Join words that were split by line-break hyphenation.',
  'Preserve real hyphenated compound words only when the hyphen is part of the original word.',
  'Preserve visible punctuation such as commas, periods, semicolons, colons, question marks, and exclamation marks.',
  'Do not describe the page, image quality, layout, fonts, margins, or visual elements.',
  'Do not summarize, correct, modernize, translate, or add any text that is not part of the main content.',
  'If a page has multiple columns, read each column from top to bottom, left to right.',
  'Extract only this page. Do not mention the page number.',
].join(' ');

export const TITLE_SYSTEM_PROMPT = [
  'You are reading the front cover of a book.',
  'Return one valid JSON object and nothing else.',
  'The JSON object must have this exact shape: {"title":"..."}',
  'Put only the main book title in the title field, exactly as printed on the cover.',
  'Do not include the subtitle, author name, publisher, edition, or series name.',
  'If you cannot read a title, return {"title":""}.',
  'Never add explanations, markdown fences, or any text outside the JSON object.',
].join(' ');

export const TITLE_PAGE_PROMPT = [
  'This image is the front cover of a book.',
  'Read the main title of the book exactly as printed.',
].join(' ');

export const TOC_SYSTEM_PROMPT = [
  'You are reading the table of contents (index/summary) page of a book.',
  'Return one valid JSON array and nothing else.',
  'The JSON array must have this exact shape: [{"title":"Chapter Title","page":1}]',
  '"title" is the chapter or section title exactly as printed.',
  '"page" is the integer page number printed next to that title in the contents.',
  'Include every listed entry that has a page number, preserving their order.',
  'Do not invent entries and do not include entries without a page number.',
  'If the image is not a table of contents, return an empty array [].',
  'Never add explanations, markdown fences, or any text outside the JSON array.',
].join(' ');

export const TOC_PAGE_PROMPT = [
  'This image is the table of contents / index page of a book.',
  'Extract every chapter or section listed together with the page number shown for it.',
  'Read titles exactly as printed and keep them in the order they appear.',
].join(' ');
