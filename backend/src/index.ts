import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import { Server as SocketServer } from 'socket.io';
import { connectDb } from './db.js';
import { migrateLegacyVoices, migrateSanitizeOcrText } from './models/Book.js';
import { seedLexicons } from './models/Lexicon.js';
import { booksRouter, registerBookSync } from './routes/books.js';
import { lexiconRouter } from './routes/lexicon.js';
import { PORT, FRONTEND_ORIGIN, DATA_DIR } from './config.js';
import { ENGINES, getEngine, isEngineUp } from './services/ttsEngines.js';
import fs from 'fs/promises';

process.on('unhandledRejection', err => console.error('Unhandled promise rejection:', err));

async function main() {
  await connectDb();
  await migrateLegacyVoices();
  await migrateSanitizeOcrText();
  await seedLexicons();
  await fs.mkdir(path.join(DATA_DIR, 'books'), { recursive: true });

  const app = express();
  const server = http.createServer(app);
  const io = new SocketServer(server, {
    cors: { origin: FRONTEND_ORIGIN, methods: ['GET', 'POST'] },
  });

  app.use(cors({ origin: FRONTEND_ORIGIN }));
  app.use(express.json());

  app.use('/api/books', booksRouter(io));
  app.use('/api/lexicon', lexiconRouter());

  // Selectable TTS models (engines).
  app.get('/api/models', (_req, res) => {
    res.json(ENGINES.map(e => ({ id: e.id, label: e.label })));
  });

  // Voices for a given model. First checks the engine is reachable (its server
  // may be an offline laptop); reports `available` so the UI can say so.
  app.get('/api/models/:id/voices', async (req, res) => {
    const engine = getEngine(req.params.id);
    if (!engine) return res.status(404).json({ error: 'unknown model' });

    if (!(await isEngineUp(engine))) {
      return res.json({ available: false, voices: [] });
    }
    try {
      const r = await fetch(`${engine.api}/v1/audio/voices`);
      const data = await r.json() as unknown;
      const list = Array.isArray(data)
        ? data
        : (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).voices))
          ? (data as Record<string, unknown>).voices
          : null;
      res.json({ available: true, voices: Array.isArray(list) && list.length ? list : engine.fallbackVoices });
    } catch {
      res.json({ available: true, voices: engine.fallbackVoices });
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
