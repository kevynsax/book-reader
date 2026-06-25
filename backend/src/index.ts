import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import { Server as SocketServer } from 'socket.io';
import { connectDb } from './db.js';
import { migrateLegacyVoices, migrateSanitizeOcrText, migrateSummaryPages } from './models/Book.js';
import { seedLexicons } from './models/Lexicon.js';
import { booksRouter, registerBookSync } from './routes/books.js';
import { lexiconRouter } from './routes/lexicon.js';
import { PORT, FRONTEND_ORIGIN, DATA_DIR } from './config.js';
import { MODELS, getModel } from './services/ttsEngines.js';
import { getServers, serverStatus, fetchCatalog } from './services/ttsServers.js';
import fs from 'fs/promises';

process.on('unhandledRejection', err => console.error('Unhandled promise rejection:', err));

async function main() {
  await connectDb();
  await migrateLegacyVoices();
  await migrateSummaryPages();
  await migrateSanitizeOcrText();
  await seedLexicons();
  await fs.mkdir(path.join(DATA_DIR, 'books'), { recursive: true });

  const app = express();
  app.set('trust proxy', true);
  const server = http.createServer(app);
  const io = new SocketServer(server, {
    cors: { origin: FRONTEND_ORIGIN, methods: ['GET', 'POST'] },
  });

  app.use(cors({ origin: FRONTEND_ORIGIN }));
  app.use(express.json());

  app.use('/api/books', booksRouter(io));
  app.use('/api/lexicon', lexiconRouter());

  // Available TTS servers (MacBook + remote), with online state + active model,
  // so the UI can show where generation will run.
  app.get('/api/servers', async (_req, res) => {
    res.json(await Promise.all(getServers().map(serverStatus)));
  });

  // Selectable TTS models — the union of what the servers advertise via
  // /v1/models, falling back to the static catalog if all servers are offline.
  app.get('/api/models', async (_req, res) => {
    const catalogs = await Promise.all(getServers().map(fetchCatalog));
    const byId = new Map<string, { id: string; label: string }>();
    for (const list of catalogs) {
      for (const m of list) if (!byId.has(m.id)) byId.set(m.id, { id: m.id, label: m.label });
    }
    if (byId.size === 0) {
      for (const m of MODELS) byId.set(m.id, { id: m.id, label: m.label });
    }
    res.json([...byId.values()]);
  });

  // Voices for a given model. A model is `available` if any server is online
  // (it can be loaded there). For cloned-voice models we read the live voice
  // list off any reachable server; named-voice models (Kokoro) use the catalog.
  app.get('/api/models/:id/voices', async (req, res) => {
    const model = getModel(req.params.id);
    if (!model) return res.status(404).json({ error: 'unknown model' });

    const statuses = await Promise.all(getServers().map(serverStatus));
    const online = statuses.filter(s => s.online);
    if (online.length === 0) return res.json({ available: false, voices: [] });

    if (model.named) {
      return res.json({ available: true, voices: model.fallbackVoices });
    }
    for (const s of online) {
      try {
        const r = await fetch(`${s.url}/v1/audio/voices`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) continue;
        const data = await r.json() as unknown;
        const list = Array.isArray(data)
          ? data
          : (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).voices))
            ? (data as Record<string, unknown>).voices as string[]
            : null;
        if (Array.isArray(list) && list.length) return res.json({ available: true, voices: list });
      } catch { /* try the next server */ }
    }
    res.json({ available: true, voices: model.fallbackVoices });
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
