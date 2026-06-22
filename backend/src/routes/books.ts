import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { Server as SocketServer } from 'socket.io';
import { Book, IVoiceTrack, freshTracks, trackForVoice } from '../models/Book.js';
import { DATA_DIR } from '../config.js';
import { processBook, generateBookAudio, generateVoiceAudio, regenerateChapterAudio } from '../workers/bookProcessor.js';
import { findPageImagePath, copyPageAsCover } from '../services/pdfService.js';
import { detectChapters } from '../services/ocrService.js';
import { synthesizeSample, timelinePathFor } from '../services/ttsService.js';
import { sanitizePageText } from '../lib/sanitize.js';

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

function sanitizeBook<T extends { ocrPages?: { text: string }[] }>(book: T): T {
  if (book.ocrPages) {
    book.ocrPages = book.ocrPages.map(p => ({ ...p, text: sanitizePageText(p.text) }));
  }
  return book;
}

export function registerBookSync(io: SocketServer) {
  io.on('connection', socket => {
    socket.on('subscribe-to-books', async (payload: { lastUpdate?: string } = {}) => {
      const since = payload?.lastUpdate ? new Date(payload.lastUpdate) : null;
      const filter = since && !isNaN(since.getTime()) ? { updatedAt: { $gt: since } } : {};
      const books = await Book.find(filter).sort({ createdAt: -1 }).lean();
      socket.emit('books:sync', books.map(sanitizeBook));
    });

    socket.on('subscribe-to-book', async (payload: { bookId?: string } = {}) => {
      if (!payload?.bookId) return;
      const book = await Book.findById(payload.bookId).lean().catch(() => null);
      if (book) socket.emit('books:sync', [sanitizeBook(book)]);
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

    const { name, summaryPage, coverPage, firstPage, lastPage, voice } = req.body as Record<string, string>;

    if (!summaryPage || !coverPage || !firstPage || !lastPage) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const booksDir = path.join(DATA_DIR, 'books');
    await fs.mkdir(booksDir, { recursive: true });

    const book = await Book.create({
      name: name?.trim() ?? '',
      summaryPage: parseInt(summaryPage),
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

      const summaryImagePath = await findPageImagePath(book.folderPath, book.summaryPage);
      if (!summaryImagePath) return res.status(404).json({ error: 'Summary page image not found' });

      const completedPages = book.ocrPages
        .filter(p => p.status === 'complete')
        .map(p => ({ page: p.page, text: sanitizePageText(p.text) }));

      const chapters = await detectChapters(summaryImagePath, completedPages);
      res.json({ summaryPage: book.summaryPage, chapters });
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

    const { chapters, voice } = req.body as {
      chapters: { title: string; startPage: number; startChar?: number }[];
      voice?: string;
    };

    if (!Array.isArray(chapters) || chapters.length === 0) {
      return res.status(400).json({ error: 'chapters array is required' });
    }

    if (voice && voice.trim()) book.voices = [voice.trim()];

    book.chapters = chapters.map(c => ({
      title: c.title,
      startPage: c.startPage,
      startChar: c.startChar ?? 0,
      tracks: freshTracks(book.voices),
    })) as unknown as typeof book.chapters;

    await book.save();
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

    let anyStale = false;
    for (let i = 0; i < book.chapters.length; i++) {
      const chStart = book.chapters[i].startPage;
      const chEnd   = i + 1 < book.chapters.length ? book.chapters[i + 1].startPage : book.lastPage;
      if (pageNum >= chStart && pageNum <= chEnd) {
        for (const track of book.chapters[i].tracks) {
          if (track.audioStatus === 'complete') { track.audioStatus = 'stale'; anyStale = true; }
        }
      }
    }

    await book.save();
    io.emit('book:update', {
      bookId: book._id.toString(),
      updatedAt: book.updatedAt,
      ocrPage: { page: pageNum, text, status: 'complete' },
    });
    if (anyStale) {
      io.emit('book:update', {
        bookId: book._id.toString(),
        chapters: book.chapters,
      });
    }
    res.json({ message: 'Saved' });
  });

  router.post('/:id/chapters/:idx/regenerate', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const idx = parseInt(req.params.idx);
    if (!book.chapters[idx]) return res.status(404).json({ error: 'Chapter not found' });

    for (const track of book.chapters[idx].tracks) track.audioStatus = 'generating';
    await book.save();
    io.emit('book:update', { bookId: book._id.toString(), updatedAt: book.updatedAt, chapters: book.chapters });

    res.json({ message: 'Regeneration started' });

    regenerateChapterAudio(book._id.toString(), idx, io).catch(err =>
      console.error(`regenerateChapterAudio ${book._id} ch${idx} failed:`, err)
    );
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
      chapters: book.chapters,
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

    for (const chapter of book.chapters) {
      const track = trackForVoice(chapter, voice);
      if (track?.audioPath) await fs.unlink(track.audioPath).catch(() => {});
      chapter.tracks = chapter.tracks.filter((t: IVoiceTrack) => t.voice !== voice) as typeof chapter.tracks;
    }
    book.voices = book.voices.filter(v => v !== voice);

    await book.save();
    io.emit('book:update', {
      bookId: book._id.toString(),
      updatedAt: book.updatedAt,
      voices: book.voices,
      chapters: book.chapters,
    });
    res.json({ message: 'Voice removed' });
  });

  router.delete('/:id', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    await fs.rm(book.folderPath, { recursive: true, force: true }).catch(() => {});
    await book.deleteOne();
    res.json({ message: 'Deleted' });
  });

  return router;
}
