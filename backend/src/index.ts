import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import { Server as SocketServer } from 'socket.io';
import { connectDb } from './db.js';
import { migrateLegacyVoices } from './models/Book.js';
import { booksRouter, registerBookSync } from './routes/books.js';
import { PORT, FRONTEND_ORIGIN, DATA_DIR, TTS_API, FALLBACK_VOICES } from './config.js';
import fs from 'fs/promises';

async function main() {
  await connectDb();
  await migrateLegacyVoices();
  await fs.mkdir(path.join(DATA_DIR, 'books'), { recursive: true });

  const app = express();
  const server = http.createServer(app);
  const io = new SocketServer(server, {
    cors: { origin: FRONTEND_ORIGIN, methods: ['GET', 'POST'] },
  });

  app.use(cors({ origin: FRONTEND_ORIGIN }));
  app.use(express.json());

  app.use('/api/books', booksRouter(io));

  // Proxy Kokoro voices so the frontend doesn't need to call the TTS API directly
  app.get('/api/voices', async (_req, res) => {
    try {
      const r = await fetch(`${TTS_API}/v1/audio/voices`);
      const data = await r.json() as unknown;
      if (Array.isArray(data)) return res.json(data);
      if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).voices))
        return res.json((data as Record<string, unknown>).voices);
      res.json(FALLBACK_VOICES);
    } catch {
      res.json(FALLBACK_VOICES);
    }
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  registerBookSync(io);

  io.on('connection', socket => {
    console.log('Client connected:', socket.id);
    socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
  });

  server.listen(PORT, () => console.log(`Book Reader backend listening on port ${PORT}`));
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
