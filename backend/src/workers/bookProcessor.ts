import fs from 'fs/promises';
import path from 'path';
import { Server as SocketServer } from 'socket.io';
import { Book, IBook, IChapter, IVoiceTrack, freshTracks, trackForVoice, deriveTrackStatus, serializeChaptersForClient } from '../models/Book.js';
import { splitPdfIntoPages, findPageImagePath, getAllPagePaths, copyPageAsCover } from '../services/pdfService.js';
import { ocrPage, detectChapters, extractBookTitle } from '../services/ocrService.js';
import { sanitizePageText } from '../lib/sanitize.js';
import { synthesizeSegment, assembleChapter } from '../services/ttsService.js';
import { reflowSentences, splitLongSentence } from '../lib/sentences.js';
import { normalizeForSpeech } from '../services/textNormalizer.js';
import { parseVoice } from '../services/ttsEngines.js';
import { readyServersFor, pickReadyServer, TtsServer } from '../services/ttsServers.js';
import { DEFAULT_LANGUAGE } from '../config.js';
import { resolveLang } from '../data/bibleBooks.js';

function emit(io: SocketServer, book: IBook, update: Record<string, unknown>) {
  io.emit('book:update', { bookId: book._id.toString(), updatedAt: book.updatedAt, ...update });
}

// Serializes book.save() across the parallel per-server workers that share one
// Mongoose document — concurrent saves would throw ParallelSaveError. Rendering
// (the slow TTS + ffmpeg work) still runs in parallel; only the DB write waits.
class SaveLock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

// The chapter's text sliced per page (by startChar/endChar), kept as separate
// strings so phase 2 can apply the cross-page sentence-continuation rule.
function extractChapterPageTexts(
  chapters: IBook['chapters'],
  idx: number,
  ocrPages: IBook['ocrPages'],
  lastPage: number,
): string[] {
  const chapter   = chapters[idx];
  const next      = chapters[idx + 1];
  const startPage = chapter.startPage;
  const startChar = chapter.startChar ?? 0;
  const endPage   = next ? next.startPage : lastPage;
  const endChar   = next ? (next.startChar ?? 0) : -1;

  const pages = ocrPages
    .filter(p => p.page >= startPage && p.page <= endPage && p.status === 'complete')
    .sort((a, b) => a.page - b.page);

  return pages.map(p => {
    const text    = sanitizePageText(p.text);
    const isFirst = p.page === startPage;
    const isLast  = p.page === endPage;
    if (isFirst && isLast) return endChar >= 0 ? text.slice(startChar, endChar) : text.slice(startChar);
    if (isFirst) return text.slice(startChar);
    if (isLast)  return endChar >= 0 ? text.slice(0, endChar) : text;
    return text;
  });
}

// A page's own language for speech normalization, falling back to the default
// when OCR couldn't determine it.
export function speechLanguage(language: string | undefined): string {
  return language && language !== 'unknown' ? resolveLang(language) : resolveLang(DEFAULT_LANGUAGE);
}

function startsLowercase(s: string): boolean {
  const m = s.match(/\p{L}/u);
  if (!m) return false;
  const ch = m[0];
  return ch !== ch.toUpperCase() && ch === ch.toLowerCase();
}

// Phase 2: each line of the (phase-1 reflowed) page text is a sentence. At a page
// seam, a first line that starts lowercase continues the previous page's last
// sentence; one that starts with a capital begins a new sentence.
function assembleSentences(pageTexts: string[]): string[] {
  const out: string[] = [];
  pageTexts.forEach((pageText, pi) => {
    const lines = pageText.split('\n').map(l => l.trim()).filter(Boolean);
    lines.forEach((line, li) => {
      if (pi > 0 && li === 0 && out.length > 0 && startsLowercase(line)) {
        out[out.length - 1] = `${out[out.length - 1]} ${line}`;
      } else {
        out.push(line);
      }
    });
  });
  return out;
}

// Dominant language for a chapter: first non-'unknown' page language in its
// page range, falling back to the configured default. Resolved to a supported
// ISO code so it doubles as the TTS lang_code (Kokoro maps 'pt'/'en', not raw
// OCR strings like 'pt-br' or 'portuguese').
function chapterLanguage(
  chapters: IBook['chapters'],
  idx: number,
  ocrPages: IBook['ocrPages'],
  lastPage: number,
): string {
  const startPage = chapters[idx].startPage;
  const endPage   = chapters[idx + 1] ? chapters[idx + 1].startPage : lastPage;
  const lang = ocrPages
    .filter(p => p.page >= startPage && p.page <= endPage && p.status === 'complete')
    .map(p => p.language)
    .find(l => l && l !== 'unknown');
  return resolveLang(lang || DEFAULT_LANGUAGE);
}

async function setProgress(
  io: SocketServer,
  book: IBook,
  current: number,
  total: number,
  message: string,
  status?: IBook['status']
) {
  book.progress = { current, total, message };
  if (status) book.status = status;
  await book.save();
  emit(io, book, { status: book.status, progress: book.progress });
}

export async function processBook(bookId: string, io: SocketServer): Promise<void> {
  const book = await Book.findById(bookId);
  if (!book) return;

  try {
    await setProgress(io, book, 0, 1, 'Splitting pages…', 'splitting_pages');
    const totalPages = await splitPdfIntoPages(book.filePath, book.folderPath);
    book.totalPages = totalPages;
    await book.save();

    await setProgress(io, book, 0, 1, 'Extracting cover…', 'extracting_cover');
    const coverSrcPath = await findPageImagePath(book.folderPath, book.coverPage);
    if (coverSrcPath) {
      const coverDest = path.join(book.folderPath, 'cover.jpg');
      await copyPageAsCover(coverSrcPath, coverDest);
      book.coverImagePath = coverDest;
      await book.save();
      emit(io, book, { coverImagePath: coverDest });
    }

    if (book.coverImagePath && !book.name.trim()) {
      await setProgress(io, book, 0, 1, 'Reading title…', 'reading_title');
      try {
        const title = await extractBookTitle(book.coverImagePath);
        if (title) {
          book.name = title;
          await book.save();
          emit(io, book, { name: title });
        }
      } catch {
      }
    }

    const readPages: number[] = [];
    for (let p = book.firstPage; p <= book.lastPage; p++) readPages.push(p);

    book.ocrPages = readPages.map(p => ({ page: p, text: '', language: 'unknown', status: 'pending' }));
    book.status = 'ocr_processing';
    await book.save();
    emit(io, book, { status: 'ocr_processing', totalPages, ocrPages: book.ocrPages });

    const allPagePaths = await getAllPagePaths(book.folderPath);

    for (let i = 0; i < readPages.length; i++) {
      const pageNum = readPages[i];
      const pageIdx = pageNum - 1;
      const imagePath = allPagePaths[pageIdx];
      if (!imagePath) continue;

      book.ocrPages[i].status = 'processing';
      await book.save();
      emit(io, book, {
        progress: { current: i + 1, total: readPages.length, message: `OCR page ${pageNum}/${book.lastPage}…` },
        ocrPage: { page: pageNum, status: 'processing' },
      });

      try {
        const result = await ocrPage(imagePath);
        const reflowed = reflowSentences(result.content);
        book.ocrPages[i].text = reflowed;
        book.ocrPages[i].language = result.language;
        book.ocrPages[i].readText = await normalizeForSpeech(reflowed, speechLanguage(result.language));
        book.ocrPages[i].status = 'complete';
      } catch {
        book.ocrPages[i].status = 'error';
      }

      await book.save();
      emit(io, book, {
        progress: { current: i + 1, total: readPages.length, message: `OCR page ${pageNum}/${book.lastPage}…` },
        ocrPage: { page: pageNum, text: book.ocrPages[i].text, readText: book.ocrPages[i].readText, status: book.ocrPages[i].status },
      });
    }

    await setProgress(io, book, 0, 1, 'Detecting chapters…', 'detecting_chapters');
    const completedPages = book.ocrPages
      .filter(p => p.status === 'complete')
      .map(p => ({ page: p.page, text: sanitizePageText(p.text) }));

    const summaryImagePath = await findPageImagePath(book.folderPath, book.summaryPage);
    const suggestions = summaryImagePath
      ? await detectChapters(summaryImagePath, completedPages)
      : [];

    book.chapters = suggestions.map(s => ({
      title: s.title,
      startPage: s.page,
      startChar: s.startChar,
      tracks: freshTracks(book.voices),
    })) as unknown as typeof book.chapters;

    book.status = 'awaiting_chapter_review';
    book.progress = { current: 0, total: 0, message: 'Awaiting chapter review…' };
    await book.save();
    emit(io, book, {
      status: 'awaiting_chapter_review',
      progress: book.progress,
      chapters: book.chapters,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    book.status = 'error';
    book.errorMessage = message;
    await book.save();
    emit(io, book, { status: 'error', errorMessage: message });
  }
}

export function chapterAudioPath(audioDir: string, chapterIdx: number, voice: string): string {
  // Composite voice ids contain ':'; make them filesystem-safe.
  const safeVoice = voice.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(audioDir, `chapter-${String(chapterIdx + 1).padStart(3, '0')}__${safeVoice}.mp3`);
}

// Assign a subdocument array on a Mongoose doc (typed escape hatch for .set).
function setSubdoc(doc: unknown, path: string, value: unknown): void {
  (doc as { set: (p: string, v: unknown) => void }).set(path, value);
}

// Directory and per-sentence file paths for a chapter/voice's segments.
function segmentDir(audioDir: string, chapterIdx: number, voice: string): string {
  const safeVoice = voice.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(audioDir, `chapter-${String(chapterIdx + 1).padStart(3, '0')}__${safeVoice}`);
}

function segmentAudioPath(audioDir: string, chapterIdx: number, voice: string, order: number): string {
  return path.join(segmentDir(audioDir, chapterIdx, voice), `seg-${String(order + 1).padStart(4, '0')}.mp3`);
}

// Make a track's segments run 1:1 with the chapter's sentences, preserving any
// already-rendered segment audio (matched by sentenceId).
function ensureSegments(track: IVoiceTrack, chapter: IChapter): void {
  const byId = new Map(track.segments.map(s => [String(s.sentenceId), s]));
  const next = [...chapter.sentences]
    .sort((a, b) => a.order - b.order)
    .map(sen => {
      const ex = byId.get(String(sen._id));
      return ex
        ? { sentenceId: sen._id, audioPath: ex.audioPath, durationSecs: ex.durationSecs, audioStatus: ex.audioStatus, audioError: ex.audioError }
        : { sentenceId: sen._id, audioStatus: 'pending' as const };
    });
  setSubdoc(track, 'segments', next);
}

// Ordered {audioPath, durationSecs, text} for assembly, by sentence order.
function orderedSegmentInputs(chapter: IChapter, track: IVoiceTrack) {
  const byId = new Map(track.segments.map(s => [String(s.sentenceId), s]));
  return [...chapter.sentences]
    .sort((a, b) => a.order - b.order)
    .map(sen => {
      const seg = byId.get(String(sen._id));
      return { audioPath: seg?.audioPath ?? '', durationSecs: seg?.durationSecs ?? 0, text: sen.text, display: sen.display || sen.text };
    });
}

// Build the editable, speech-ready sentence list for a chapter (once). Returns
// false if there's no readable text yet.
async function buildSentences(book: IBook, idx: number, lock: SaveLock): Promise<boolean> {
  const chapter = book.chapters[idx];
  if (chapter.sentences.length > 0) return true;

  const pageTexts = extractChapterPageTexts(book.chapters, idx, book.ocrPages, book.lastPage);
  const units = assembleSentences(pageTexts);
  if (units.length === 0) return false;

  const language = chapterLanguage(book.chapters, idx, book.ocrPages, book.lastPage);
  // `text` is what gets read (speech-normalized); `display` keeps the original
  // reviewed text so the player shows it instead of the TTS conversions. A long
  // sentence that splits for TTS falls back to the piece text for display.
  const sentences: { text: string; display: string }[] = [];
  for (const unit of units) {
    const norm = (await normalizeForSpeech(unit, language)).trim();
    if (!norm) continue;
    const pieces = splitLongSentence(norm);
    if (pieces.length === 1) sentences.push({ text: pieces[0], display: unit });
    else for (const piece of pieces) sentences.push({ text: piece, display: piece });
  }
  if (sentences.length === 0) return false;

  setSubdoc(chapter, 'sentences', sentences.map((s, order) => ({ order, ...s })));
  await lock.run(() => book.save());
  return true;
}

// Concatenate a track's complete segments into the chapter mp3 + timeline, or
// reflect a segment error onto the track. Emits the resulting chapter status.
async function finalizeTrack(
  book: IBook,
  io: SocketServer,
  idx: number,
  voice: string,
  audioDir: string,
  lock: SaveLock,
  preservePlayable = false,
): Promise<void> {
  const chapter = book.chapters[idx];
  const track = trackForVoice(chapter, voice);
  if (!track) return;

  const allComplete = track.segments.length > 0 && track.segments.every(s => s.audioStatus === 'complete');
  if (allComplete) {
    const audioPath = chapterAudioPath(audioDir, idx, voice);
    try {
      const durationSecs = await assembleChapter(orderedSegmentInputs(chapter, track), audioPath);
      track.audioPath = audioPath;
      track.audioDurationSecs = Math.round(durationSecs);
      track.audioStatus = 'complete';
      track.audioError = undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`assembleChapter ${book._id} ch${idx + 1} (${voice}):`, err);
      track.audioStatus = 'error';
      track.audioError = `Assembly failed: ${message}`;
    }
  } else if (preservePlayable && track.audioPath) {
    // A single-sentence re-render failed but the previously assembled chapter
    // audio is still valid — keep it playable; the bad segment shows in the editor.
    track.audioStatus = 'complete';
  } else {
    track.audioStatus = deriveTrackStatus(track.segments);
    track.audioError = track.segments.find(s => s.audioStatus === 'error')?.audioError;
  }

  await lock.run(() => book.save());
  emit(io, book, {
    chapterUpdate: {
      idx,
      voice,
      audioStatus: track.audioStatus,
      audioPath: track.audioPath,
      audioDurationSecs: track.audioDurationSecs,
      audioError: track.audioError,
    },
  });
}

// Render one chapter for one voice on a specific server: build sentences once,
// synthesize each not-yet-complete segment, then assemble. Resumable — already
// complete segments are skipped, so a mid-chapter failure only retries the rest.
async function renderChapter(
  book: IBook,
  io: SocketServer,
  voice: string,
  idx: number,
  server: TtsServer,
  audioDir: string,
  lock: SaveLock,
  progress: { done: number; total: number },
): Promise<void> {
  const chapter = book.chapters[idx];
  const track = trackForVoice(chapter, voice);
  if (!track || track.audioStatus === 'complete') return;

  if (!(await buildSentences(book, idx, lock))) {
    const audioError = 'No readable text for this chapter (run OCR first?)';
    console.error(`renderChapter ${book._id} ch${idx + 1} (${voice}): ${audioError}`);
    track.audioStatus = 'error';
    track.audioError = audioError;
    await lock.run(() => book.save());
    emit(io, book, { chapterUpdate: { idx, voice, audioStatus: 'error', audioError } });
    return;
  }

  ensureSegments(track, chapter);
  track.audioStatus = 'generating';
  track.audioError = undefined;
  progress.done++;
  await lock.run(() => book.save());
  emit(io, book, {
    progress: { current: progress.done, total: progress.total, message: `Generating "${chapter.title}"… (${server.label})` },
    chapterUpdate: { idx, voice, audioStatus: 'generating' },
  });

  const language = chapterLanguage(book.chapters, idx, book.ocrPages, book.lastPage);
  const sentenceById = new Map(chapter.sentences.map(s => [String(s._id), s]));

  for (const seg of track.segments) {
    if (seg.audioStatus === 'complete') continue;
    const sentence = sentenceById.get(String(seg.sentenceId));
    if (!sentence) continue;

    const segPath = segmentAudioPath(audioDir, idx, voice, sentence.order);
    seg.audioStatus = 'generating';
    seg.audioError = undefined;
    try {
      const durationSecs = await synthesizeSegment(sentence.text, segPath, server.url, voice, language);
      seg.audioPath = segPath;
      seg.durationSecs = durationSecs;
      seg.audioStatus = 'complete';
      seg.audioError = undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`renderChapter ${book._id} ch${idx + 1} seg#${sentence.order + 1} (${voice}) on ${server.label}:`, err);
      seg.audioStatus = 'error';
      seg.audioError = `${message} (${server.label})`;
    }
    await lock.run(() => book.save());
    emit(io, book, {
      segmentUpdate: { chapterIdx: idx, voice, sentenceId: String(seg.sentenceId), audioStatus: seg.audioStatus, audioError: seg.audioError },
    });
  }

  await finalizeTrack(book, io, idx, voice, audioDir, lock);
}

// Render every pending chapter for one voice, fanning the chapters across all
// ready servers (a shared cursor: each server pulls the next chapter as it frees
// up). If no server is reachable, the voice's chapters are marked errored.
async function renderVoice(
  book: IBook,
  io: SocketServer,
  voice: string,
  audioDir: string,
  lock: SaveLock,
  progress: { done: number; total: number },
): Promise<void> {
  const pending = book.chapters
    .map((_, i) => i)
    .filter(i => {
      const t = trackForVoice(book.chapters[i], voice);
      return t && t.audioStatus !== 'complete';
    });
  if (pending.length === 0) return;

  const { model } = parseVoice(voice);
  const servers = await readyServersFor(model.id);

  if (servers.length === 0) {
    const audioError = `No TTS server is online for model "${model.id}" — start the server and try again.`;
    console.error(`renderVoice ${book._id} (${voice}): ${audioError}`);
    for (const i of pending) {
      const t = trackForVoice(book.chapters[i], voice);
      if (t) { t.audioStatus = 'error'; t.audioError = audioError; }
    }
    progress.done += pending.length;
    await lock.run(() => book.save());
    emit(io, book, { chapters: serializeChaptersForClient(book.chapters) });
    return;
  }

  let cursor = 0;
  const takeNext = () => (cursor < pending.length ? pending[cursor++] : -1);
  await Promise.all(
    servers.map(async server => {
      for (let idx = takeNext(); idx !== -1; idx = takeNext()) {
        await renderChapter(book, io, voice, idx, server, audioDir, lock, progress);
      }
    }),
  );
}

async function generateForVoices(
  book: IBook,
  io: SocketServer,
  voices: string[],
  manageBookStatus: boolean
): Promise<void> {
  const audioDir = path.join(book.folderPath, 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  if (manageBookStatus) {
    book.status = 'generating_audio';
    await book.save();
    emit(io, book, { status: 'generating_audio' });
  }

  const lock = new SaveLock();
  const progress = { done: 0, total: voices.length * book.chapters.length };

  // Voices render one at a time so each server loads a model once per voice
  // (no hot-swap thrashing); a voice's chapters fan out across the servers.
  for (const voice of voices) {
    await renderVoice(book, io, voice, audioDir, lock, progress);
  }

  const failed = book.chapters.flatMap(c => c.tracks).filter(t => t.audioStatus === 'error');

  if (manageBookStatus) {
    if (failed.length > 0) {
      const reasons = [...new Set(failed.map(t => t.audioError).filter(Boolean))];
      book.status = 'error';
      book.errorMessage =
        `${failed.length} chapter${failed.length > 1 ? 's' : ''} failed to generate` +
        (reasons.length ? `: ${reasons.join('; ')}` : '.');
      await book.save();
      emit(io, book, { status: 'error', errorMessage: book.errorMessage, chapters: serializeChaptersForClient(book.chapters) });
    } else {
      book.status = 'complete';
      book.progress = { current: progress.total, total: progress.total, message: 'Complete!' };
      await book.save();
      emit(io, book, { status: 'complete', progress: book.progress, chapters: serializeChaptersForClient(book.chapters) });
    }
  } else {
    await book.save();
    emit(io, book, { chapters: serializeChaptersForClient(book.chapters) });
  }
}

export async function generateBookAudio(bookId: string, io: SocketServer): Promise<void> {
  const book = await Book.findById(bookId);
  if (!book) return;

  try {
    await generateForVoices(book, io, book.voices, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    book.status = 'error';
    book.errorMessage = message;
    await book.save();
    emit(io, book, { status: 'error', errorMessage: message });
  }
}

export async function generateVoiceAudio(bookId: string, io: SocketServer, voice: string | string[]): Promise<void> {
  const book = await Book.findById(bookId);
  if (!book) return;

  const voices = Array.isArray(voice) ? voice : [voice];
  try {
    await generateForVoices(book, io, voices, false);
  } catch (err) {
    console.error(`generateVoiceAudio ${bookId} ${voices.join(', ')} failed:`, err);
  }
}

// Full chapter rebuild (e.g. after OCR/chapter-boundary edits): discard cached
// sentences + segment audio so the latest text is re-read from scratch.
export async function regenerateChapterAudio(bookId: string, chapterIdx: number, io: SocketServer): Promise<void> {
  const book = await Book.findById(bookId);
  if (!book) return;

  const chapter = book.chapters[chapterIdx];
  if (!chapter) return;

  const audioDir = path.join(book.folderPath, 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  setSubdoc(chapter, 'sentences', []);
  for (const t of chapter.tracks) {
    setSubdoc(t, 'segments', []);
    t.audioStatus = 'pending';
    t.audioError = undefined;
  }
  await book.save();
  for (const voice of book.voices) {
    await fs.rm(segmentDir(audioDir, chapterIdx, voice), { recursive: true, force: true }).catch(() => {});
  }

  const lock = new SaveLock();
  const progress = { done: 0, total: book.voices.length };
  for (const voice of book.voices) {
    const { model } = parseVoice(voice);
    const server = await pickReadyServer(model.id);
    if (!server) {
      const track = trackForVoice(chapter, voice);
      const audioError = `No TTS server is online for model "${model.id}" — start the server and try again.`;
      if (track) { track.audioStatus = 'error'; track.audioError = audioError; }
      await book.save();
      emit(io, book, { chapterUpdate: { idx: chapterIdx, voice, audioStatus: 'error', audioError } });
      continue;
    }
    await renderChapter(book, io, voice, chapterIdx, server, audioDir, lock, progress);
  }
}

// Discard one voice's cached segments + audio files for a chapter so it
// re-synthesizes from scratch. Keeps the chapter's shared sentences intact.
async function clearTrackAudio(book: IBook, audioDir: string, chapterIdx: number, voice: string): Promise<void> {
  const track = trackForVoice(book.chapters[chapterIdx], voice);
  if (track) {
    setSubdoc(track, 'segments', []);
    track.audioStatus = 'pending';
    track.audioError = undefined;
    track.audioPath = undefined;
    track.audioDurationSecs = undefined;
  }
  await fs.rm(segmentDir(audioDir, chapterIdx, voice), { recursive: true, force: true }).catch(() => {});
  await fs.rm(chapterAudioPath(audioDir, chapterIdx, voice), { force: true }).catch(() => {});
}

// Regenerate one voice across every chapter (e.g. generation stalled or a server
// restarted mid-run). Resets just that voice's tracks, then re-renders it.
export async function regenerateVoiceAudio(bookId: string, voice: string, io: SocketServer): Promise<void> {
  const book = await Book.findById(bookId);
  if (!book) return;
  if (!book.voices.includes(voice)) return;

  const audioDir = path.join(book.folderPath, 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  for (let idx = 0; idx < book.chapters.length; idx++) {
    await clearTrackAudio(book, audioDir, idx, voice);
  }
  await book.save();
  emit(io, book, { chapters: serializeChaptersForClient(book.chapters) });

  try {
    await generateForVoices(book, io, [voice], false);
  } catch (err) {
    console.error(`regenerateVoiceAudio ${bookId} ${voice} failed:`, err);
  }
}

// Regenerate a single chapter for a single voice.
export async function regenerateChapterVoiceAudio(bookId: string, chapterIdx: number, voice: string, io: SocketServer): Promise<void> {
  const book = await Book.findById(bookId);
  if (!book) return;

  const chapter = book.chapters[chapterIdx];
  if (!chapter || !book.voices.includes(voice)) return;

  const audioDir = path.join(book.folderPath, 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  await clearTrackAudio(book, audioDir, chapterIdx, voice);
  await book.save();
  emit(io, book, { chapterUpdate: { idx: chapterIdx, voice, audioStatus: 'pending' } });

  const lock = new SaveLock();
  const progress = { done: 0, total: 1 };
  const { model } = parseVoice(voice);
  const server = await pickReadyServer(model.id);
  if (!server) {
    const track = trackForVoice(chapter, voice);
    const audioError = `No TTS server is online for model "${model.id}" — start the server and try again.`;
    if (track) { track.audioStatus = 'error'; track.audioError = audioError; }
    await book.save();
    emit(io, book, { chapterUpdate: { idx: chapterIdx, voice, audioStatus: 'error', audioError } });
    return;
  }
  await renderChapter(book, io, voice, chapterIdx, server, audioDir, lock, progress);
}

// Re-synthesize one sentence's segment for the given voices, then reassemble
// each affected chapter mp3. Shared by edit + single-sentence regenerate.
async function rerenderSegment(
  book: IBook,
  io: SocketServer,
  chapterIdx: number,
  sentenceId: string,
  voices: string[],
): Promise<void> {
  const chapter = book.chapters[chapterIdx];
  if (!chapter) return;
  const sentence = chapter.sentences.find(s => String(s._id) === sentenceId);
  if (!sentence) return;

  const audioDir = path.join(book.folderPath, 'audio');
  const language = chapterLanguage(book.chapters, chapterIdx, book.ocrPages, book.lastPage);
  const lock = new SaveLock();

  for (const voice of voices) {
    const track = trackForVoice(chapter, voice);
    if (!track) continue;
    ensureSegments(track, chapter);
    const seg = track.segments.find(s => String(s.sentenceId) === sentenceId);
    if (!seg) continue;

    seg.audioStatus = 'generating';
    seg.audioError = undefined;
    await lock.run(() => book.save());
    emit(io, book, { segmentUpdate: { chapterIdx, voice, sentenceId, audioStatus: 'generating' } });

    const { model } = parseVoice(voice);
    const server = await pickReadyServer(model.id);
    if (!server) {
      seg.audioStatus = 'error';
      seg.audioError = `No TTS server is online for model "${model.id}".`;
      await lock.run(() => book.save());
      emit(io, book, { segmentUpdate: { chapterIdx, voice, sentenceId, audioStatus: 'error', audioError: seg.audioError } });
      await finalizeTrack(book, io, chapterIdx, voice, audioDir, lock, true);
      continue;
    }

    const segPath = segmentAudioPath(audioDir, chapterIdx, voice, sentence.order);
    try {
      const durationSecs = await synthesizeSegment(sentence.text, segPath, server.url, voice, language);
      seg.audioPath = segPath;
      seg.durationSecs = durationSecs;
      seg.audioStatus = 'complete';
      seg.audioError = undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`rerenderSegment ${book._id} ch${chapterIdx + 1} (${voice}):`, err);
      seg.audioStatus = 'error';
      seg.audioError = `${message} (${server.label})`;
    }
    await lock.run(() => book.save());
    emit(io, book, { segmentUpdate: { chapterIdx, voice, sentenceId, audioStatus: seg.audioStatus, audioError: seg.audioError } });
    await finalizeTrack(book, io, chapterIdx, voice, audioDir, lock, true);
  }
}

// Edit a sentence's text, then re-render its segment for every voice.
export async function editSentence(
  bookId: string,
  chapterIdx: number,
  sentenceId: string,
  text: string,
  io: SocketServer,
): Promise<void> {
  const book = await Book.findById(bookId);
  if (!book) return;
  const chapter = book.chapters[chapterIdx];
  if (!chapter) return;
  const sentence = chapter.sentences.find(s => String(s._id) === sentenceId);
  if (!sentence) return;

  sentence.text = text;
  sentence.display = text;
  for (const track of chapter.tracks) {
    const seg = track.segments.find(s => String(s.sentenceId) === sentenceId);
    if (seg) { seg.audioStatus = 'stale'; seg.audioError = undefined; }
  }
  await book.save();
  emit(io, book, { sentenceUpdate: { chapterIdx, sentenceId, text } });

  await rerenderSegment(book, io, chapterIdx, sentenceId, book.voices);
}

// Re-render one sentence's segment without changing its text (e.g. it errored).
export async function regenerateSegment(
  bookId: string,
  chapterIdx: number,
  sentenceId: string,
  io: SocketServer,
  voice?: string,
): Promise<void> {
  const book = await Book.findById(bookId);
  if (!book) return;
  const voices = voice ? [voice] : book.voices;
  await rerenderSegment(book, io, chapterIdx, sentenceId, voices);
}
