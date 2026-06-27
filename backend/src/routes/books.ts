import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { Server as SocketServer } from 'socket.io';
import { Book, IVoiceTrack, ISegment, ISentence, freshTracks, trackForVoice, serializeChaptersForClient } from '../models/Book.js';
import { DATA_DIR, DELETE_ALLOWED_IPS } from '../config.js';
import { processBook, reprocessPageOcr, generateBookAudio, generateVoiceAudio, regenerateChapterAudio, regenerateVoiceAudio, regenerateChapterVoiceAudio, continueChapterVoiceAudio, reassembleBookAudio, editSentence, deleteSentence, regenerateSegment, bookSpeechLanguage, stopBookAudio } from '../workers/bookProcessor.js';
import { normalizeForSpeech } from '../services/textNormalizer.js';
import { findPageImagePath, copyPageAsCover } from '../services/pdfService.js';
import { detectChapters, fetchSlmModels, splitLineIntoSentences, reviewLineGrammar } from '../services/ocrService.js';
import { synthesizeSample, timelinePathFor } from '../services/ttsService.js';
import { sanitizePageText } from '../lib/sanitize.js';

const deleteAllowedIps = new Set(DELETE_ALLOWED_IPS);

function clientIp(req: express.Request): string {
  return (req.ip ?? '').replace(/^::ffff:/, '');
}

// No configured IPs means the restriction is disabled — deletion is allowed
// from anywhere (useful in production where a proxy masks the real client IP).
function canDeleteBooks(req: express.Request): boolean {
  return deleteAllowedIps.size === 0 || deleteAllowedIps.has(clientIp(req));
}

const upload = multer({
  dest: '/tmp/book-uploads/',
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  },
});

const coverUpload = multer({
  dest: '/tmp/cover-uploads/',
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// Accepts the summary pages as a JSON array, a comma-separated string, or a
// single value, returning the unique positive page numbers in order.
function parseSummaryPages(raw: unknown): number[] {
  let values: unknown[] = [];
  if (Array.isArray(raw)) values = raw;
  else if (typeof raw === 'number') values = [raw];
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      values = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      values = raw.split(',');
    }
  }
  const out: number[] = [];
  for (const v of values) {
    const n = typeof v === 'number' ? v : parseInt(String(v).trim());
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

function sampleText(ocrPages: { page: number; text: string; status: string }[], firstPage: number): string {
  const pages = ocrPages
    .filter(p => p.status === 'complete' && p.page >= firstPage)
    .sort((a, b) => a.page - b.page);

  for (const p of pages) {
    const paragraphs = sanitizePageText(p.text).split(/\n\n+/).map(s => s.trim()).filter(Boolean);
    const startIdx = paragraphs.findIndex(s => s.length >= 40);
    if (startIdx >= 0) {
      const joined = paragraphs.slice(startIdx).join('\n\n');
      if (joined.length >= 40) return joined.slice(0, 1500);
    }
  }
  return pages.map(p => sanitizePageText(p.text)).join(' ').trim().slice(0, 1500);
}

function sanitizeBook<T extends { ocrPages?: { text: string }[]; chapters?: unknown[] }>(book: T): T {
  if (book.ocrPages) {
    book.ocrPages = book.ocrPages.map(p => ({ ...p, text: sanitizePageText(p.text) }));
  }
  // Sentences and per-segment data stay server-side; the editor fetches them on
  // demand so library/book sync payloads stay small.
  if (Array.isArray(book.chapters)) {
    book.chapters = serializeChaptersForClient(book.chapters as never) as never;
  }
  return book;
}

export function registerBookSync(io: SocketServer) {
  io.on('connection', socket => {
    socket.on('subscribe-to-books', async (payload: { lastUpdate?: string } = {}) => {
      const since = payload?.lastUpdate ? new Date(payload.lastUpdate) : null;
      const filter: Record<string, unknown> = { deleted: { $ne: true } };
      if (since && !isNaN(since.getTime())) filter.updatedAt = { $gt: since };
      const books = await Book.find(filter).sort({ createdAt: -1 }).lean();
      socket.emit('books:sync', books.map(sanitizeBook));
    });

    socket.on('subscribe-to-book', async (payload: { bookId?: string } = {}) => {
      if (!payload?.bookId) return;
      const book = await Book.findById(payload.bookId).lean().catch(() => null);
      if (book && !book.deleted) socket.emit('books:sync', [sanitizeBook(book)]);
    });
  });
}

export function booksRouter(io: SocketServer) {
  const router = express.Router();

  router.post('/', (req, res, next) => {
    upload.single('file')(req, res, err => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  }, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { name, summaryPage, summaryPages, coverPage, firstPage, lastPage, voice } = req.body as Record<string, string>;

    const summary = parseSummaryPages(summaryPages ?? summaryPage);

    if (summary.length === 0 || !coverPage || !firstPage || !lastPage) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const booksDir = path.join(DATA_DIR, 'books');
    await fs.mkdir(booksDir, { recursive: true });

    const book = await Book.create({
      name: name?.trim() ?? '',
      summaryPages: summary,
      coverPage: parseInt(coverPage),
      firstPage: parseInt(firstPage),
      lastPage: parseInt(lastPage),
      voices: [voice || 'chatterbox:pt-BR-FranciscaNeural'],
      folderPath: 'pending',
      filePath: 'pending',
      status: 'uploading',
    });

    const bookId = book._id.toString();
    const folderPath = path.join(booksDir, bookId);
    const filePath = path.join(folderPath, 'original.pdf');

    await fs.mkdir(folderPath, { recursive: true });
    await fs.copyFile(req.file.path, filePath);
    await fs.unlink(req.file.path).catch(() => {});

    book.folderPath = folderPath;
    book.filePath = filePath;
    await book.save();

    res.json({ bookId, message: 'Book uploaded. Processing started.' });

    processBook(bookId, io).catch(err =>
      console.error(`processBook ${bookId} failed:`, err)
    );
  });

  router.patch('/:id', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const { name } = req.body as { name?: string };
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    book.name = name.trim();
    await book.save();
    io.emit('book:update', { bookId: book._id.toString(), updatedAt: book.updatedAt, name: book.name });
    res.json({ message: 'Renamed' });
  });

  // Re-run the whole import pipeline from the already-stored PDF and page
  // settings, so a failed/partial run can be retried without re-uploading or
  // re-entering cover/summary/first/last page numbers.
  router.post('/:id/reprocess', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });
    if (!book.filePath || book.filePath === 'pending' || !existsSync(book.filePath)) {
      return res.status(409).json({ error: 'Original PDF is no longer available' });
    }

    // Optional reconfiguration: the user may review and change the cover,
    // summary, first, and last pages before restarting the import.
    const cfg = req.body ?? {};
    const applyPage = (v: unknown): number | null =>
      Number.isInteger(v) && (v as number) > 0 ? (v as number) : null;
    const cover   = applyPage(cfg.coverPage);
    let first     = applyPage(cfg.firstPage);
    let last      = applyPage(cfg.lastPage);
    const summary = cfg.summaryPages !== undefined ? parseSummaryPages(cfg.summaryPages) : null;
    if (first !== null && last !== null && first > last) [first, last] = [last, first];
    if (cover   !== null)               book.coverPage    = cover;
    if (summary !== null && summary.length) book.summaryPages = summary;
    if (first   !== null)               book.firstPage    = first;
    if (last    !== null)               book.lastPage     = last;

    book.status = 'splitting_pages';
    book.errorMessage = undefined;
    book.progress = { current: 0, total: 1, message: 'Restarting import…' };
    book.chapters.splice(0, book.chapters.length);
    book.ocrPages.splice(0, book.ocrPages.length);
    await book.save();

    const bookId = book._id.toString();
    io.emit('book:update', {
      bookId,
      updatedAt: book.updatedAt,
      status: book.status,
      progress: book.progress,
      chapters: serializeChaptersForClient(book.chapters),
      ocrPages: book.ocrPages,
    });

    res.json({ message: 'Reprocessing started.' });

    processBook(bookId, io).catch(err =>
      console.error(`processBook ${bookId} failed:`, err)
    );
  });

  // Continue a failed/partial import where it stopped: keep the pages already
  // read and only re-run OCR for the pending/failed ones, then carry on with
  // chapter detection. Unlike reprocess, completed work is preserved.
  router.post('/:id/resume', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });
    if (!book.filePath || book.filePath === 'pending' || !existsSync(book.filePath)) {
      return res.status(409).json({ error: 'Original PDF is no longer available' });
    }

    book.status = book.ocrPages.length > 0 ? 'ocr_processing' : 'splitting_pages';
    book.errorMessage = undefined;
    book.progress = { current: 0, total: 1, message: 'Resuming import…' };
    await book.save();

    const bookId = book._id.toString();
    io.emit('book:update', {
      bookId,
      updatedAt: book.updatedAt,
      status: book.status,
      progress: book.progress,
      errorMessage: '',
    });

    res.json({ message: 'Resuming import.' });

    processBook(bookId, io, { resume: true }).catch(err =>
      console.error(`processBook (resume) ${bookId} failed:`, err)
    );
  });

  // Discard the import error without retrying: clear the error message, accept
  // any failed pages as-is, and move the book on to chapter review so it stays
  // usable (or can be deleted).
  router.post('/:id/dismiss-error', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    book.errorMessage = undefined;
    for (const p of book.ocrPages) {
      if (p.status === 'error') { p.status = 'complete'; p.error = undefined; }
    }
    if (book.status === 'error') book.status = 'awaiting_chapter_review';
    await book.save();

    const bookId = book._id.toString();
    io.emit('book:update', {
      bookId,
      updatedAt: book.updatedAt,
      status: book.status,
      errorMessage: '',
      ocrPages: book.ocrPages,
    });

    res.json({ message: 'Error dismissed.' });
  });

  router.get('/:id/sample', async (req, res) => {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ error: 'Not found' });

    const voice = (req.query.voice as string) || book.voices[0];
    if (!voice) return res.status(400).json({ error: 'voice is required' });

    const text = sampleText(book.ocrPages, book.firstPage);
    if (!text) return res.status(409).json({ error: 'No readable text yet' });

    try {
      const audio = await synthesizeSample(text, voice);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(audio);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'TTS failed';
      res.status(502).json({ error: message });
    }
  });

  router.get('/line-split/models', async (_req, res) => {
    try {
      res.json(await fetchSlmModels());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list SLM models';
      res.status(502).json({ error: message });
    }
  });

  router.get('/:id/pages/:pageNum', async (req, res) => {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ error: 'Not found' });

    const partsDir = path.join(book.folderPath, 'parts');
    try {
      const files = await fs.readdir(partsDir);
      const sorted = files.filter(f => f.endsWith('.jpg')).sort();
      const pageNum = parseInt(req.params.pageNum);
      const target = sorted[pageNum - 1];
      if (!target) return res.status(404).json({ error: 'Page not found' });
      res.setHeader('Content-Type', 'image/jpeg');
      createReadStream(path.join(partsDir, target)).pipe(res);
    } catch {
      res.status(404).json({ error: 'Pages not yet available' });
    }
  });

  router.get('/:id/cover', async (req, res) => {
    const book = await Book.findById(req.params.id).lean();
    if (!book?.coverImagePath || !existsSync(book.coverImagePath)) {
      return res.status(404).json({ error: 'Cover not found' });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(book.coverImagePath).pipe(res);
  });

  router.put('/:id/cover', (req, res, next) => {
    coverUpload.single('image')(req, res, err => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  }, async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const coverDest = path.join(book.folderPath, 'cover.jpg');
    await fs.copyFile(req.file.path, coverDest);
    await fs.unlink(req.file.path).catch(() => {});

    book.coverImagePath = coverDest;
    await book.save();
    io.emit('book:update', { bookId: book._id.toString(), updatedAt: book.updatedAt, coverImagePath: coverDest });
    res.json({ message: 'Cover updated' });
  });

  router.put('/:id/cover/page', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const { page } = req.body as { page: number };
    if (!page) return res.status(400).json({ error: 'page is required' });

    const imagePath = await findPageImagePath(book.folderPath, page);
    if (!imagePath) return res.status(404).json({ error: 'Page not found' });

    const coverDest = path.join(book.folderPath, 'cover.jpg');
    await copyPageAsCover(imagePath, coverDest);
    book.coverImagePath = coverDest;
    book.coverPage = page;
    await book.save();
    io.emit('book:update', { bookId: book._id.toString(), updatedAt: book.updatedAt, coverImagePath: coverDest });
    res.json({ message: 'Cover updated' });
  });

  router.post('/:id/summary/detect', async (req, res) => {
    try {
      const book = await Book.findById(req.params.id).lean();
      if (!book) return res.status(404).json({ error: 'Not found' });

      const summaryImagePaths = (await Promise.all(
        book.summaryPages.map(p => findPageImagePath(book.folderPath, p))
      )).filter((p): p is string => !!p);
      if (summaryImagePaths.length === 0) return res.status(404).json({ error: 'Summary page image not found' });

      const completedPages = book.ocrPages
        .filter(p => p.status === 'complete')
        .map(p => ({ page: p.page, text: sanitizePageText(p.text) }));

      const chapters = await detectChapters(summaryImagePaths, completedPages);
      res.json({ summaryPages: book.summaryPages, chapters });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read summary';
      res.status(502).json({ error: message });
    }
  });

  router.patch('/:id/chapters', async (req, res) => {
    try {
      const book = await Book.findById(req.params.id);
      if (!book) return res.status(404).json({ error: 'Not found' });

      const { chapters } = req.body as {
        chapters: { title: string; startPage: number; startChar?: number }[];
      };

      if (!Array.isArray(chapters) || chapters.length === 0) {
        return res.status(400).json({ error: 'chapters array is required' });
      }

      const toRegen = new Set<number>();
      for (let i = 0; i < chapters.length; i++) {
        const existing = book.chapters[i];
        if (!existing
            || existing.startPage !== chapters[i].startPage
            || (existing.startChar ?? 0) !== (chapters[i].startChar ?? 0)) {
          toRegen.add(i);
          if (i > 0) toRegen.add(i - 1);
        }
      }

      const nextChapters = chapters.map((c, i) => {
        const existing = book.chapters[i];
        const needsRegen = toRegen.has(i);
        const tracks = book.voices.map(voice => {
          const prev = existing ? trackForVoice(existing, voice) : undefined;
          const hadAudio = prev?.audioStatus === 'complete';
          return {
            voice,
            audioPath: prev?.audioPath,
            audioDurationSecs: prev?.audioDurationSecs,
            audioStatus: needsRegen ? (hadAudio ? 'stale' : 'pending') : (prev?.audioStatus ?? 'pending'),
          };
        });
        return { title: c.title, startPage: c.startPage, startChar: c.startChar ?? 0, tracks };
      });

      const updated = await Book.findByIdAndUpdate(
        req.params.id,
        { $set: { chapters: nextChapters } },
        { new: true },
      );
      if (!updated) return res.status(404).json({ error: 'Not found' });

      io.emit('book:update', { bookId: updated._id.toString(), updatedAt: updated.updatedAt, chapters: updated.chapters });
      res.json({ message: 'Chapters updated' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update chapters';
      res.status(500).json({ error: message });
    }
  });

  router.put('/:id/chapters', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const { chapters, voice, voices } = req.body as {
      chapters: { title: string; startPage: number; startChar?: number }[];
      voice?: string;
      voices?: string[];
    };

    if (!Array.isArray(chapters) || chapters.length === 0) {
      return res.status(400).json({ error: 'chapters array is required' });
    }

    const requestedVoices = Array.from(
      new Set((voices ?? (voice ? [voice] : [])).map(v => v.trim()).filter(Boolean))
    );
    if (requestedVoices.length) book.voices = requestedVoices;

    book.chapters = chapters.map(c => ({
      title: c.title,
      startPage: c.startPage,
      startChar: c.startChar ?? 0,
      tracks: freshTracks(book.voices),
    })) as unknown as typeof book.chapters;

    await book.save();
    io.emit('book:update', {
      bookId: book._id.toString(),
      updatedAt: book.updatedAt,
      voices: book.voices,
      chapters: serializeChaptersForClient(book.chapters),
    });
    res.json({ message: 'Chapters saved. Audio generation started.' });

    generateBookAudio(book._id.toString(), io).catch(err =>
      console.error(`generateBookAudio ${book._id} failed:`, err)
    );
  });

  router.post('/:id/generate', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });
    if (book.chapters.length === 0) return res.status(400).json({ error: 'No chapters to generate' });

    res.json({ message: 'Generation started' });

    generateBookAudio(book._id.toString(), io).catch(err =>
      console.error(`generateBookAudio ${book._id} failed:`, err)
    );
  });

  router.post('/:id/stop', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });
    if (!(await stopBookAudio(book._id.toString(), io))) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ message: 'Stopping audio generation…' });
  });

  router.get('/:id/chapters/:chapterIdx/audio', async (req, res) => {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ error: 'Not found' });

    const idx = parseInt(req.params.chapterIdx);
    const chapter = book.chapters[idx];
    if (!chapter) return res.status(404).json({ error: 'Not found' });

    const voice = (req.query.voice as string) || book.voices[0];
    const track = chapter.tracks.find((t: IVoiceTrack) => t.voice === voice);
    if (!track?.audioPath || !existsSync(track.audioPath)) {
      return res.status(404).json({ error: 'Audio not ready' });
    }
    const audioPath = track.audioPath;

    const stat = await fs.stat(audioPath);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    // Reassembly rewrites the file in place without changing its rounded-second
    // cache-buster, so force revalidation: the ETag tracks size+mtime, and the
    // browser only re-downloads when the audio actually changed (else a 304).
    const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end   = match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (start > end || end >= stat.size) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      return createReadStream(audioPath, { start, end }).pipe(res);
    }

    res.setHeader('Content-Length', stat.size);
    createReadStream(audioPath).pipe(res);
  });

  // Read-along timeline (sentence start/end times) for a chapter's audio.
  router.get('/:id/chapters/:chapterIdx/timeline', async (req, res) => {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ error: 'Not found' });

    const idx = parseInt(req.params.chapterIdx);
    const chapter = book.chapters[idx];
    if (!chapter) return res.status(404).json({ error: 'Not found' });

    const voice = (req.query.voice as string) || book.voices[0];
    const track = chapter.tracks.find((t: IVoiceTrack) => t.voice === voice);
    if (!track?.audioPath) return res.status(404).json({ error: 'No timeline' });

    const timelinePath = timelinePathFor(track.audioPath);
    if (!existsSync(timelinePath)) return res.status(404).json({ error: 'No timeline' });

    res.setHeader('Content-Type', 'application/json');
    // Rewritten in place on every reassembly; never serve a stale copy or the
    // highlight desyncs from the (possibly re-rendered) audio.
    res.setHeader('Cache-Control', 'no-store');
    createReadStream(timelinePath).pipe(res);
  });

  router.put('/:id/pages/:page/text', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const pageNum = parseInt(req.params.page);
    const { text } = req.body as { text: string };
    if (typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

    const pageDoc = book.ocrPages.find(p => p.page === pageNum);
    if (!pageDoc) return res.status(404).json({ error: 'Page not found' });

    pageDoc.text = text;
    pageDoc.readText = await normalizeForSpeech(text, bookSpeechLanguage(book, pageDoc.language));

    let anyStale = false;
    for (let i = 0; i < book.chapters.length; i++) {
      const chStart = book.chapters[i].startPage;
      const chEnd   = i + 1 < book.chapters.length ? book.chapters[i + 1].startPage : book.lastPage;
      if (pageNum >= chStart && pageNum <= chEnd) {
        book.chapters[i].set('sentences', []);
        for (const track of book.chapters[i].tracks) {
          if (track.audioStatus === 'complete') { track.audioStatus = 'stale'; anyStale = true; }
        }
      }
    }

    await book.save();
    io.emit('book:update', {
      bookId: book._id.toString(),
      updatedAt: book.updatedAt,
      ocrPage: { page: pageNum, text, readText: pageDoc.readText, status: 'complete' },
    });
    if (anyStale) {
      io.emit('book:update', {
        bookId: book._id.toString(),
        chapters: book.chapters,
      });
    }
    res.json({ message: 'Saved' });
  });

  // Re-run OCR for a single page (e.g. one garbled page in an otherwise good book).
  router.post('/:id/pages/:page/reocr', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const pageNum = parseInt(req.params.page);
    const pageDoc = book.ocrPages.find(p => p.page === pageNum);
    if (!pageDoc) return res.status(404).json({ error: 'Page not found' });

    res.json({ message: 'Re-OCR started.' });

    reprocessPageOcr(book._id.toString(), pageNum, io).catch(err =>
      console.error(`reprocessPageOcr ${book._id} page ${pageNum} failed:`, err)
    );
  });

  router.post('/:id/line-split', async (req, res) => {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ error: 'Not found' });

    const { line, model } = req.body as { line?: string; model?: string };
    if (typeof line !== 'string' || !line.trim()) {
      return res.status(400).json({ error: 'line is required' });
    }

    try {
      const split = await splitLineIntoSentences(sanitizePageText(line).trim(), typeof model === 'string' ? model : undefined);
      if (!split) return res.status(422).json({ error: 'No sentence split found' });
      res.json(split);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to split line';
      res.status(502).json({ error: message });
    }
  });

  router.post('/:id/line-typos', async (req, res) => {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ error: 'Not found' });

    const { line, model } = req.body as { line?: string; model?: string };
    if (typeof line !== 'string' || !line.trim()) {
      return res.status(400).json({ error: 'line is required' });
    }

    try {
      const review = await reviewLineGrammar(sanitizePageText(line).trim(), typeof model === 'string' ? model : undefined);
      res.json({ corrected: review?.corrected ?? '' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to review line';
      res.status(502).json({ error: message });
    }
  });

  router.post('/:id/chapters/:idx/regenerate', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const idx = parseInt(req.params.idx);
    if (!book.chapters[idx]) return res.status(404).json({ error: 'Chapter not found' });

    for (const track of book.chapters[idx].tracks) track.audioStatus = 'generating';
    await book.save();
    io.emit('book:update', { bookId: book._id.toString(), updatedAt: book.updatedAt, chapters: serializeChaptersForClient(book.chapters) });

    res.json({ message: 'Regeneration started' });

    regenerateChapterAudio(book._id.toString(), idx, io).catch(err =>
      console.error(`regenerateChapterAudio ${book._id} ch${idx} failed:`, err)
    );
  });

  // Rebuild chapter mp3s + timelines from cached segments (no re-synthesis) to
  // repair read-along timelines written by the older lossy assembly.
  router.post('/:id/reassemble', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    res.json({ message: 'Reassembly started' });

    reassembleBookAudio(book._id.toString(), io).catch(err =>
      console.error(`reassembleBookAudio ${book._id} failed:`, err)
    );
  });

  // Regenerate one voice across all chapters (recover from a stalled run / server restart).
  router.post('/:id/voices/:voice/regenerate', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const voice = req.params.voice;
    if (!book.voices.includes(voice)) return res.status(404).json({ error: 'Voice not found' });

    for (const chapter of book.chapters) {
      const track = trackForVoice(chapter, voice);
      if (track) track.audioStatus = 'generating';
    }
    await book.save();
    io.emit('book:update', { bookId: book._id.toString(), updatedAt: book.updatedAt, chapters: serializeChaptersForClient(book.chapters) });

    res.json({ message: 'Voice regeneration started' });

    regenerateVoiceAudio(book._id.toString(), voice, io).catch(err =>
      console.error(`regenerateVoiceAudio ${book._id} ${voice} failed:`, err)
    );
  });

  // Regenerate a single chapter for a single voice.
  router.post('/:id/chapters/:idx/voices/:voice/regenerate', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const idx = parseInt(req.params.idx);
    if (!book.chapters[idx]) return res.status(404).json({ error: 'Chapter not found' });

    const voice = req.params.voice;
    if (!book.voices.includes(voice)) return res.status(404).json({ error: 'Voice not found' });

    const track = trackForVoice(book.chapters[idx], voice);
    if (track) track.audioStatus = 'generating';
    await book.save();
    io.emit('book:update', { bookId: book._id.toString(), updatedAt: book.updatedAt, chapters: serializeChaptersForClient(book.chapters) });

    res.json({ message: 'Regeneration started' });

    regenerateChapterVoiceAudio(book._id.toString(), idx, voice, io).catch(err =>
      console.error(`regenerateChapterVoiceAudio ${book._id} ch${idx} ${voice} failed:`, err)
    );
  });

  // Continue (resume) a chapter for one voice after an error/interruption: keep
  // every finished sentence and render only the missing ones, then reassemble.
  router.post('/:id/chapters/:idx/voices/:voice/continue', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const idx = parseInt(req.params.idx);
    if (!book.chapters[idx]) return res.status(404).json({ error: 'Chapter not found' });

    const voice = req.params.voice;
    if (!book.voices.includes(voice)) return res.status(404).json({ error: 'Voice not found' });

    const track = trackForVoice(book.chapters[idx], voice);
    if (track) track.audioStatus = 'generating';
    await book.save();
    io.emit('book:update', { bookId: book._id.toString(), updatedAt: book.updatedAt, chapters: serializeChaptersForClient(book.chapters) });

    res.json({ message: 'Continue started' });

    continueChapterVoiceAudio(book._id.toString(), idx, voice, io).catch(err =>
      console.error(`continueChapterVoiceAudio ${book._id} ch${idx} ${voice} failed:`, err)
    );
  });

  // Editable sentences for a chapter, with each sentence's per-segment status for
  // the requested voice. Empty for books generated before sentence-level audio.
  router.get('/:id/chapters/:idx/sentences', async (req, res) => {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ error: 'Not found' });

    const chapter = book.chapters[parseInt(req.params.idx)];
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

    const voice = (req.query.voice as string) || book.voices[0];
    const track = chapter.tracks.find((t: IVoiceTrack) => t.voice === voice);
    const segBySentence = new Map<string, ISegment>(
      ((track?.segments ?? []) as ISegment[]).map(s => [String(s.sentenceId), s])
    );

    const sentences = [...(chapter.sentences ?? [])]
      .sort((a: ISentence, b: ISentence) => a.order - b.order)
      .map((s: ISentence) => {
        const seg = segBySentence.get(String(s._id));
        return {
          _id: String(s._id),
          order: s.order,
          text: s.text,
          audioStatus: seg?.audioStatus ?? 'pending',
          audioError: seg?.audioError,
        };
      });

    res.json({ voice, editable: sentences.length > 0, sentences });
  });

  // Edit one sentence's text → re-render just its segment for every voice.
  router.put('/:id/chapters/:idx/sentences/:sentenceId', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const idx = parseInt(req.params.idx);
    const chapter = book.chapters[idx];
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

    const { text } = req.body as { text?: string };
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });

    const sentence = chapter.sentences.find(s => String(s._id) === req.params.sentenceId);
    if (!sentence) return res.status(404).json({ error: 'Sentence not found' });

    res.json({ message: 'Sentence updated. Re-rendering audio.' });

    editSentence(book._id.toString(), idx, req.params.sentenceId, text.trim(), io).catch(err =>
      console.error(`editSentence ${book._id} ch${idx} ${req.params.sentenceId} failed:`, err)
    );
  });

  // Delete one sentence and reassemble chapter audio from the remaining segments.
  router.delete('/:id/chapters/:idx/sentences/:sentenceId', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const idx = parseInt(req.params.idx);
    const chapter = book.chapters[idx];
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' });
    if (!chapter.sentences.some(s => String(s._id) === req.params.sentenceId)) {
      return res.status(404).json({ error: 'Sentence not found' });
    }
    if (chapter.sentences.length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the only sentence in a chapter' });
    }

    res.json({ message: 'Sentence deleted. Reassembling audio.' });

    deleteSentence(book._id.toString(), idx, req.params.sentenceId, io).catch(err =>
      console.error(`deleteSentence ${book._id} ch${idx} ${req.params.sentenceId} failed:`, err)
    );
  });

  // Re-render one sentence's segment without changing its text (e.g. it errored).
  router.post('/:id/chapters/:idx/sentences/:sentenceId/regenerate', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const idx = parseInt(req.params.idx);
    const chapter = book.chapters[idx];
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' });
    if (!chapter.sentences.some(s => String(s._id) === req.params.sentenceId)) {
      return res.status(404).json({ error: 'Sentence not found' });
    }

    const voice = (req.body as { voice?: string }).voice;
    res.json({ message: 'Re-rendering sentence.' });

    regenerateSegment(book._id.toString(), idx, req.params.sentenceId, io, voice).catch(err =>
      console.error(`regenerateSegment ${book._id} ch${idx} ${req.params.sentenceId} failed:`, err)
    );
  });

  // Stream one sentence's segment audio (for in-editor preview).
  router.get('/:id/chapters/:idx/sentences/:sentenceId/audio', async (req, res) => {
    const book = await Book.findById(req.params.id).lean();
    if (!book) return res.status(404).json({ error: 'Not found' });

    const chapter = book.chapters[parseInt(req.params.idx)];
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

    const voice = (req.query.voice as string) || book.voices[0];
    const track = chapter.tracks.find((t: IVoiceTrack) => t.voice === voice);
    const seg = track?.segments.find((s: ISegment) => String(s.sentenceId) === req.params.sentenceId);
    if (!seg?.audioPath || !existsSync(seg.audioPath)) return res.status(404).json({ error: 'No audio for this sentence' });

    res.setHeader('Content-Type', 'audio/mpeg');
    createReadStream(seg.audioPath).pipe(res);
  });

  router.post('/:id/voices', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const body = req.body as { voice?: string; voices?: string[] };
    const requested = Array.from(
      new Set((body.voices ?? (body.voice ? [body.voice] : [])).map(v => v.trim()).filter(Boolean))
    );
    if (requested.length === 0) return res.status(400).json({ error: 'voice is required' });

    const toAdd = requested.filter(v => !book.voices.includes(v));
    if (toAdd.length === 0) return res.status(409).json({ error: 'Voice already added' });

    for (const voice of toAdd) {
      book.voices.push(voice);
      for (const chapter of book.chapters) {
        if (!trackForVoice(chapter, voice)) {
          chapter.tracks.push({ voice, audioStatus: 'pending' });
        }
      }
    }
    await book.save();
    io.emit('book:update', {
      bookId: book._id.toString(),
      updatedAt: book.updatedAt,
      voices: book.voices,
      chapters: serializeChaptersForClient(book.chapters),
    });
    res.json({ message: `${toAdd.length} voice(s) added. Generation started.` });

    generateVoiceAudio(book._id.toString(), io, toAdd).catch(err =>
      console.error(`generateVoiceAudio ${book._id} ${toAdd.join(', ')} failed:`, err)
    );
  });

  router.delete('/:id/voices/:voice', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const voice = req.params.voice;
    if (!book.voices.includes(voice)) return res.status(404).json({ error: 'Voice not found' });
    if (book.voices.length <= 1) return res.status(400).json({ error: 'A book must have at least one voice' });

    const safeVoice = voice.replace(/[^a-zA-Z0-9._-]/g, '_');
    const audioDir = path.join(book.folderPath, 'audio');
    for (let idx = 0; idx < book.chapters.length; idx++) {
      const chapter = book.chapters[idx];
      const track = trackForVoice(chapter, voice);
      if (track?.audioPath) await fs.unlink(track.audioPath).catch(() => {});
      await fs.rm(path.join(audioDir, `chapter-${String(idx + 1).padStart(3, '0')}__${safeVoice}`), { recursive: true, force: true }).catch(() => {});
      chapter.tracks = chapter.tracks.filter((t: IVoiceTrack) => t.voice !== voice) as typeof chapter.tracks;
    }
    book.voices = book.voices.filter(v => v !== voice);

    await book.save();
    io.emit('book:update', {
      bookId: book._id.toString(),
      updatedAt: book.updatedAt,
      voices: book.voices,
      chapters: serializeChaptersForClient(book.chapters),
    });
    res.json({ message: 'Voice removed' });
  });

  router.get('/can-delete', (req, res) => {
    res.json({ canDelete: canDeleteBooks(req) });
  });

  router.delete('/:id', async (req, res) => {
    if (!canDeleteBooks(req)) {
      return res.status(403).json({ error: 'Deleting books is not allowed from this network' });
    }

    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    book.deleted = true;
    await book.save();
    io.emit('book:deleted', { bookId: req.params.id });
    res.json({ message: 'Deleted' });
  });

  return router;
}
