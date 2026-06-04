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

const upload = multer({
  dest: '/tmp/book-uploads/',
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  },
});

const coverUpload = multer({
  dest: '/tmp/cover-uploads/',
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

function sanitizePageText(text: string): string {
  const trimmed = text?.trim();
  if (!trimmed || trimmed[0] !== '{') return trimmed ?? '';
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.content === 'string') return parsed.content.trim();
  } catch { /* not JSON */ }
  return trimmed;
}

function sanitizeBook<T extends { ocrPages?: { text: string }[] }>(book: T): T {
  if (book.ocrPages) {
    book.ocrPages = book.ocrPages.map(p => ({ ...p, text: sanitizePageText(p.text) }));
  }
  return book;
}

// Push books changed since each client's last-seen timestamp over the socket.
// Replaces the old GET /api/books list endpoint.
export function registerBookSync(io: SocketServer) {
  io.on('connection', socket => {
    socket.on('subscribe-to-books', async (payload: { lastUpdate?: string } = {}) => {
      const since = payload?.lastUpdate ? new Date(payload.lastUpdate) : null;
      const filter = since && !isNaN(since.getTime()) ? { updatedAt: { $gt: since } } : {};
      const books = await Book.find(filter).sort({ createdAt: -1 }).lean();
      socket.emit('books:sync', books.map(sanitizeBook));
    });

    // Pull a single book (direct navigation / just-uploaded book) into the client store.
    socket.on('subscribe-to-book', async (payload: { bookId?: string } = {}) => {
      if (!payload?.bookId) return;
      const book = await Book.findById(payload.bookId).lean().catch(() => null);
      if (book) socket.emit('books:sync', [sanitizeBook(book)]);
    });
  });
}

export function booksRouter(io: SocketServer) {
  const router = express.Router();

  // Upload a new book
  router.post('/', (req, res, next) => {
    upload.single('file')(req, res, err => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  }, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { name, summaryPage, coverPage, firstPage, lastPage, voice } = req.body as Record<string, string>;

    if (!name || !summaryPage || !coverPage || !firstPage || !lastPage) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const booksDir = path.join(DATA_DIR, 'books');
    await fs.mkdir(booksDir, { recursive: true });

    // Create the book document first to get the ID
    const book = await Book.create({
      name,
      summaryPage: parseInt(summaryPage),
      coverPage: parseInt(coverPage),
      firstPage: parseInt(firstPage),
      lastPage: parseInt(lastPage),
      voices: [voice || 'pf_dora'],
      folderPath: 'pending',
      filePath: 'pending',
      status: 'uploading',
    });

    const bookId = book._id.toString();
    const folderPath = path.join(booksDir, bookId);
    const filePath = path.join(folderPath, 'original.pdf');

    await fs.mkdir(folderPath, { recursive: true });
    // copyFile + unlink instead of rename — rename fails across Docker volume boundaries (EXDEV)
    await fs.copyFile(req.file.path, filePath);
    await fs.unlink(req.file.path).catch(() => {});

    book.folderPath = folderPath;
    book.filePath = filePath;
    await book.save();

    res.json({ bookId, message: 'Book uploaded. Processing started.' });

    // Fire background task without blocking the response
    processBook(bookId, io).catch(err =>
      console.error(`processBook ${bookId} failed:`, err)
    );
  });

  // Serve a page image from the book's parts folder
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

  // Serve cover image
  router.get('/:id/cover', async (req, res) => {
    const book = await Book.findById(req.params.id).lean();
    if (!book?.coverImagePath || !existsSync(book.coverImagePath)) {
      return res.status(404).json({ error: 'Cover not found' });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(book.coverImagePath).pipe(res);
  });

  // Upload a new cover image
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

  // Set a split page as cover (no file upload — JSON body { page })
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

  // Update chapter structure without resetting audio; auto-regen chapters whose start moved
  router.patch('/:id/chapters', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const { chapters } = req.body as {
      chapters: { title: string; startPage: number; startChar?: number }[];
    };

    if (!Array.isArray(chapters) || chapters.length === 0) {
      return res.status(400).json({ error: 'chapters array is required' });
    }

    // Collect indices that need regeneration
    const toRegen = new Set<number>();
    for (let i = 0; i < chapters.length; i++) {
      const existing = book.chapters[i];
      const posChanged = !existing
        || existing.startPage !== chapters[i].startPage
        || (existing.startChar ?? 0) !== (chapters[i].startChar ?? 0);
      if (posChanged) {
        toRegen.add(i);
        if (i > 0) toRegen.add(i - 1); // previous chapter's end boundary moved too
      }
    }

    book.chapters = chapters.map((c, i) => {
      const existing = book.chapters[i];
      const needsRegen = toRegen.has(i);
      // Carry each voice's track forward; a moved chapter marks rendered audio
      // stale so it can be rebuilt, while untouched chapters keep their audio.
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
      return {
        title: c.title,
        startPage: c.startPage,
        startChar: c.startChar ?? 0,
        tracks,
      };
    }) as unknown as typeof book.chapters;

    await book.save();
    io.emit('book:update', { bookId: book._id.toString(), updatedAt: book.updatedAt, chapters: book.chapters });
    res.json({ message: 'Chapters updated' });
  });

  // Confirm chapters and start audio generation (initial import flow)
  router.put('/:id/chapters', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const { chapters } = req.body as {
      chapters: { title: string; startPage: number; startChar?: number }[];
    };

    if (!Array.isArray(chapters) || chapters.length === 0) {
      return res.status(400).json({ error: 'chapters array is required' });
    }

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

  // Stream audio for a chapter
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

    // Honor Range requests so the browser can seek (scrubber navigation).
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

  // Update the OCR text for a specific page (for manual editing)
  router.put('/:id/pages/:page/text', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const pageNum = parseInt(req.params.page);
    const { text } = req.body as { text: string };
    if (typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

    const pageDoc = book.ocrPages.find(p => p.page === pageNum);
    if (!pageDoc) return res.status(404).json({ error: 'Page not found' });

    pageDoc.text = text;

    // Mark every rendered track of every chapter that covers this page as stale
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

  // Regenerate audio for a single chapter
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

  // Add a voice to a finished book and render its audio in the background.
  router.post('/:id/voices', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const { voice } = req.body as { voice?: string };
    if (!voice) return res.status(400).json({ error: 'voice is required' });
    if (book.voices.includes(voice)) return res.status(409).json({ error: 'Voice already added' });

    book.voices.push(voice);
    // Give every chapter a pending track for the new voice (keep existing ones).
    for (const chapter of book.chapters) {
      if (!trackForVoice(chapter, voice)) {
        chapter.tracks.push({ voice, audioStatus: 'pending' });
      }
    }
    await book.save();
    io.emit('book:update', {
      bookId: book._id.toString(),
      updatedAt: book.updatedAt,
      voices: book.voices,
      chapters: book.chapters,
    });
    res.json({ message: 'Voice added. Generation started.' });

    generateVoiceAudio(book._id.toString(), io, voice).catch(err =>
      console.error(`generateVoiceAudio ${book._id} ${voice} failed:`, err)
    );
  });

  // Remove a voice (and its rendered files). A book must always keep one voice.
  router.delete('/:id/voices/:voice', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const voice = req.params.voice;
    if (!book.voices.includes(voice)) return res.status(404).json({ error: 'Voice not found' });
    if (book.voices.length <= 1) return res.status(400).json({ error: 'A book must have at least one voice' });

    // Delete the rendered files for this voice before dropping the tracks.
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

  // Delete a book
  router.delete('/:id', async (req, res) => {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    await fs.rm(book.folderPath, { recursive: true, force: true }).catch(() => {});
    await book.deleteOne();
    res.json({ message: 'Deleted' });
  });

  return router;
}
