import dotenv from 'dotenv';
dotenv.config();

export const PORT = parseInt(process.env.PORT || '3001');
export const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/book-reader';
export const SLM_API = process.env.SLM_API || 'https://slm.kevyn.com.br';
// Tried in order: SLM_API first, then SLM_API_FALLBACK when the primary errors.
export const SLM_API_FALLBACK = process.env.SLM_API_FALLBACK || 'https://ollama-macbook.kevyn.com.br';
export const SLM_MODEL = process.env.SLM_MODEL || 'qwen2.5:3b';
// Model used to split an over-long sentence in two — both up front (any sentence
// whose spoken text exceeds TTS_MAX_SENTENCE_CHARS) and during TTS verification.
// Runs on the ORIGINAL (un-normalized) sentence text so the split keeps a clean
// display.
export const SLM_SPLIT_MODEL = process.env.SLM_SPLIT_MODEL || 'gemma4:latest';
// Relative share of bulk-review work each SLM server takes. The balancer routes
// by least in-flight / weight, so a slow box (e.g. the Mac fallback) with a low
// weight only picks up a job when the fast server is already saturated.
export const SLM_PRIMARY_WEIGHT = Math.max(1, parseInt(process.env.SLM_PRIMARY_WEIGHT || '4'));
export const SLM_FALLBACK_WEIGHT = Math.max(1, parseInt(process.env.SLM_FALLBACK_WEIGHT || '1'));

export interface SlmServerConfig { url: string; weight: number; }
export const SLM_SERVERS: SlmServerConfig[] = (() => {
  const raw = [
    { url: SLM_API, weight: SLM_PRIMARY_WEIGHT },
    { url: SLM_API_FALLBACK, weight: SLM_FALLBACK_WEIGHT },
  ];
  const seen = new Set<string>();
  const out: SlmServerConfig[] = [];
  for (const s of raw) {
    const url = (s.url || '').replace(/\/+$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, weight: s.weight });
  }
  return out;
})();

// TTS servers run the same OpenAI-compatible API (see ../tts-2). Each loads one
// model at a time but can hot-swap. Synthesis is load-balanced across them.
// Required — configure via TTS_SERVERS: "id|Label|url" entries, comma- or
// newline-separated. Empty entries are dropped.
export interface TtsServerConfig { id: string; label: string; url: string; }

function parseServers(): TtsServerConfig[] {
  return (process.env.TTS_SERVERS || '')
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const [id, label, url] = entry.split('|').map(x => x.trim());
      return { id, label: label || id, url: (url || '').replace(/\/+$/, '') };
    })
    .filter(s => s.id && s.url);
}

export const TTS_SERVERS: TtsServerConfig[] = parseServers();

// QwenVL OCR servers run the same OpenAI-compatible API. Pages are OCR'd across
// them in parallel so a book is recognized faster, and a failed lane falls back
// to the others. Required — configure via QWENVL_SERVERS: "id|Label|url|model"
// entries, comma- or newline-separated. Each entry carries its own model so
// backends can differ (e.g. Ollama "qwen2.5vl:7b-q8_0" vs vLLM
// "Qwen/Qwen2.5-VL-7B-Instruct-AWQ"). Entries missing url or model are dropped.
export interface QwenVlServerConfig { id: string; label: string; url: string; model: string; }

function parseQwenVlServers(): QwenVlServerConfig[] {
  return (process.env.QWENVL_SERVERS || '')
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const [id, label, url, model] = entry.split('|').map(x => x.trim());
      return { id, label: label || id, url: (url || '').replace(/\/+$/, ''), model: (model || '').trim() };
    })
    .filter(s => s.id && s.url && s.model);
}

export const QWENVL_SERVERS: QwenVlServerConfig[] = parseQwenVlServers();

// Whisper ASR servers (OpenAI-compatible /v1/audio/transcriptions). Used to
// verify that a synthesized segment actually says what it was asked to say.
// Load-balanced by least in-flight, with the others used as fallback on error.
// Configure via WHISPER_SERVERS (comma/newline-separated URLs); defaults to the
// remote box with the MacBook as fallback.
export const WHISPER_SERVERS: string[] = (() => {
  const raw = process.env.WHISPER_SERVERS
    || 'https://whisper.kevyn.com.br,https://whisper-macbook.kevyn.com.br';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw.split(/[\n,]+/)) {
    const url = entry.trim().replace(/\/+$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
})();
export const WHISPER_MODEL = process.env.WHISPER_MODEL || 'deepdml/faster-whisper-large-v3-turbo-ct2';
export const WHISPER_TIMEOUT_MS = parseInt(process.env.WHISPER_TIMEOUT_MS || '60000');

// Post-synthesis verification: transcribe each rendered segment and compare it to
// the requested text. On a mismatch the text is split into smaller pieces (on
// punctuation, then via the SLM) and re-rendered. Toggle with TTS_VERIFY=0.
export const TTS_VERIFY = (process.env.TTS_VERIFY ?? '1') !== '0';
// Word-similarity (0..1) at or above which a transcript is accepted as a match.
export const TTS_VERIFY_THRESHOLD = parseFloat(process.env.TTS_VERIFY_THRESHOLD || '0.85');
// How many times a failing segment may be split & re-rendered before its best
// attempt is kept as-is.
export const TTS_VERIFY_MAX_DEPTH = parseInt(process.env.TTS_VERIFY_MAX_DEPTH || '3');
// Texts shorter than this skip verification — too short for Whisper to score
// reliably, and not worth the round-trip.
export const TTS_VERIFY_MIN_CHARS = parseInt(process.env.TTS_VERIFY_MIN_CHARS || '8');

// Maximum spoken (speech-normalized) length of a single sentence before audio
// generation. Anything longer is broken into natural sub-sentences by the SLM
// (gemma) up front, rather than hand-split on clause punctuation.
export const TTS_MAX_SENTENCE_CHARS = parseInt(process.env.TTS_MAX_SENTENCE_CHARS || '220');

export const DATA_DIR = process.env.DATA_DIR || './data';
// IPs allowed to delete books, comma-separated. Empty/unset disables the IP
// restriction so deletion is allowed from anywhere (e.g. behind a proxy that
// masks the client IP).
export const DELETE_ALLOWED_IPS = (process.env.DELETE_ALLOWED_IPS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
export const DEFAULT_VOICE = process.env.TTS_VOICE || 'chatterbox:pt-BR-FranciscaNeural';
export const TTS_SPEED = parseFloat(process.env.TTS_SPEED || '1.0');
// Max sentence syntheses in flight at once, balanced across the ready servers.
export const TTS_CONCURRENCY = parseInt(process.env.TTS_CONCURRENCY || '5');
// Max syntheses committed to a single TTS server at once. The tts-2 servers
// render one request at a time, so anything queued on a slow server is stuck
// there even when a faster server goes idle; 1 keeps dispatch work-conserving
// (the next segment always goes to whichever server frees up first). Raise it
// to pipeline the whisper-verify gap at the cost of deeper per-server queues.
export const TTS_SERVER_CONCURRENCY = Math.max(1, parseInt(process.env.TTS_SERVER_CONCURRENCY || '1'));
// How long a server that errored is parked before the balancer re-probes it.
export const TTS_SERVER_COOLDOWN_MS = parseInt(process.env.TTS_SERVER_COOLDOWN_MS || '15000');
// How often the balancer re-probes parked/offline servers in the background so a
// reconnected one rejoins mid-chapter. 0 disables the background probe.
export const TTS_SERVER_PROBE_MS = parseInt(process.env.TTS_SERVER_PROBE_MS || '10000');
export const TTS_VOLUME_GAIN = parseFloat(process.env.TTS_VOLUME_GAIN || '1.15');
export const TITLE_MAX_WORDS = parseInt(process.env.TITLE_MAX_WORDS || '5');
export const TITLE_SILENCE_SECS = parseFloat(process.env.TITLE_SILENCE_SECS || '0.7');
// Extra gain applied to title segments so headings read a touch louder than body.
export const TITLE_VOLUME_GAIN = parseFloat(process.env.TITLE_VOLUME_GAIN || '1.1');
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

export const LANG_SYSTEM_PROMPT = [
  'You identify the primary written language of a book page.',
  'Return one valid JSON object and nothing else.',
  'The JSON object must have this exact shape: {"language":"pt"}',
  'Use a lowercase ISO 639-1 code such as "pt", "en", "es", or "unknown".',
  'Never add explanations, markdown fences, or any text outside the JSON object.',
].join(' ');

export const LANG_PAGE_PROMPT = [
  'Identify the primary language the readable body text on this page is written in.',
  'Ignore isolated foreign quotations, names, and scripture references.',
].join(' ');
