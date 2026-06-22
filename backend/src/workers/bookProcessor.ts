import fs from 'fs/promises';
import path from 'path';
import { Server as SocketServer } from 'socket.io';
import { Book, IBook, freshTracks, trackForVoice } from '../models/Book.js';
import { splitPdfIntoPages, findPageImagePath, getAllPagePaths, copyPageAsCover } from '../services/pdfService.js';
import { ocrPage, detectChapters, extractBookTitle } from '../services/ocrService.js';
import { sanitizePageText } from '../lib/sanitize.js';
import { generateAudio } from '../services/ttsService.js';
import { parseVoice } from '../services/ttsEngines.js';
import { readyServersFor, pickReadyServer, TtsServer } from '../services/ttsServers.js';
import { DEFAULT_LANGUAGE } from '../config.js';

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

function extractChapterText(
  chapters: IBook['chapters'],
  idx: number,
  ocrPages: IBook['ocrPages'],
  lastPage: number,
): string {
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
  }).join('\n\n').trim();
}

// Dominant language for a chapter: first non-'unknown' page language in its
// page range, falling back to the configured default. Used as the TTS lang_code.
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
  return lang || DEFAULT_LANGUAGE;
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
        book.ocrPages[i].text = result.content;
        book.ocrPages[i].language = result.language;
        book.ocrPages[i].status = 'complete';
      } catch {
        book.ocrPages[i].status = 'error';
      }

      await book.save();
      emit(io, book, {
        progress: { current: i + 1, total: readPages.length, message: `OCR page ${pageNum}/${book.lastPage}…` },
        ocrPage: { page: pageNum, text: book.ocrPages[i].text, status: book.ocrPages[i].status },
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

// Render one chapter for one voice on a specific server. Mutations to the shared
// book doc are saved under `lock` to avoid concurrent-save errors.
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

  const text = extractChapterText(book.chapters, idx, book.ocrPages, book.lastPage);
  if (!text) {
    track.audioStatus = 'error';
    await lock.run(() => book.save());
    emit(io, book, { chapterUpdate: { idx, voice, audioStatus: 'error' } });
    return;
  }

  track.audioStatus = 'generating';
  progress.done++;
  await lock.run(() => book.save());
  emit(io, book, {
    progress: { current: progress.done, total: progress.total, message: `Generating "${chapter.title}"… (${server.label})` },
    chapterUpdate: { idx, voice, audioStatus: 'generating' },
  });

  const audioPath = chapterAudioPath(audioDir, idx, voice);
  const language = chapterLanguage(book.chapters, idx, book.ocrPages, book.lastPage);

  try {
    const durationSecs = await generateAudio(text, audioPath, server.url, voice, language);
    track.audioPath = audioPath;
    track.audioDurationSecs = Math.round(durationSecs);
    track.audioStatus = 'complete';
  } catch {
    track.audioStatus = 'error';
  }

  await lock.run(() => book.save());
  emit(io, book, {
    chapterUpdate: {
      idx,
      voice,
      audioStatus: track.audioStatus,
      audioPath: track.audioPath,
      audioDurationSecs: track.audioDurationSecs,
    },
  });
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
    for (const i of pending) {
      const t = trackForVoice(book.chapters[i], voice);
      if (t) t.audioStatus = 'error';
    }
    progress.done += pending.length;
    await lock.run(() => book.save());
    emit(io, book, { chapters: book.chapters });
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

  if (manageBookStatus) {
    book.status = 'complete';
    book.progress = { current: progress.total, total: progress.total, message: 'Complete!' };
    await book.save();
    emit(io, book, { status: 'complete', progress: book.progress, chapters: book.chapters });
  } else {
    await book.save();
    emit(io, book, { chapters: book.chapters });
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

export async function regenerateChapterAudio(bookId: string, chapterIdx: number, io: SocketServer): Promise<void> {
  const book = await Book.findById(bookId);
  if (!book) return;

  const chapter = book.chapters[chapterIdx];
  if (!chapter) return;

  const audioDir = path.join(book.folderPath, 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  let text: string;
  try {
    text = extractChapterText(book.chapters, chapterIdx, book.ocrPages, book.lastPage);
    if (!text) throw new Error('No text available for this chapter');
  } catch {
    for (const t of chapter.tracks) t.audioStatus = 'error';
    await book.save();
    emit(io, book, { chapters: book.chapters });
    return;
  }

  const language = chapterLanguage(book.chapters, chapterIdx, book.ocrPages, book.lastPage);
  for (const voice of book.voices) {
    const track = trackForVoice(chapter, voice);
    if (!track) continue;
    const audioPath = chapterAudioPath(audioDir, chapterIdx, voice);
    try {
      const { model } = parseVoice(voice);
      const server = await pickReadyServer(model.id);
      if (!server) throw new Error(`No TTS server available for model "${model.id}"`);
      const durationSecs = await generateAudio(text, audioPath, server.url, voice, language);
      track.audioPath = audioPath;
      track.audioDurationSecs = Math.round(durationSecs);
      track.audioStatus = 'complete';
    } catch {
      track.audioStatus = 'error';
    }
    await book.save();
    emit(io, book, {
      chapterUpdate: {
        idx: chapterIdx,
        voice,
        audioStatus: track.audioStatus,
        audioPath: track.audioPath,
        audioDurationSecs: track.audioDurationSecs,
      },
    });
  }
}
