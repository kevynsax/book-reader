import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import { Server as SocketServer } from 'socket.io';
import { connectDb } from './db.js';
import { migrateLegacyVoices, migrateSanitizeOcrText, migrateSummaryPages } from './models/Book.js';
import { seedLexicons } from './models/Lexicon.js';
import { booksRouter, registerBookSync } from './routes/books.js';
import { recoverInterruptedAudio } from './workers/bookProcessor.js';
import { lexiconRouter } from './routes/lexicon.js';
import { PORT, FRONTEND_ORIGIN, DATA_DIR } from './config.js';
import { MODELS, getModel, clonedVoiceModel } from './services/ttsEngines.js';
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
    const statuses = await Promise.all(getServers().map(serverStatus));
    const online = statuses.filter(s => s.online);

    // Known models come from the static catalog; ids only advertised by a
    // server (e.g. Orpheus) are treated as cloned-voice backends so their
    // voices list off the server instead of 404ing.
    const advertised = online.some(s => s.models.some(m => m.id === req.params.id));
    const model = getModel(req.params.id) ?? (advertised ? clonedVoiceModel(req.params.id) : undefined);
    if (!model) return res.status(404).json({ error: 'unknown model' });

    if (online.length === 0) return res.json({ available: false, voices: [] });

    if (model.named) {
      return res.json({ available: true, voices: model.fallbackVoices });
    }
    // Prefer servers that actually advertise this model, and always ask for THIS
    // model's voices (?model=) rather than whatever happens to be loaded — otherwise
    // a server with a different active model returns the wrong list (or none).
    const ordered = [...online].sort(
      (a, b) =>
        Number(b.models.some(m => m.id === req.params.id)) -
        Number(a.models.some(m => m.id === req.params.id)),
    );
    for (const s of ordered) {
      try {
        const r = await fetch(
          `${s.url}/v1/audio/voices?model=${encodeURIComponent(req.params.id)}`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (!r.ok) continue;
        const data = await r.json() as unknown;
        const obj = (data && typeof data === 'object') ? data as Record<string, unknown> : null;
        const list = Array.isArray(data)
          ? data
          : (obj && Array.isArray(obj.voices))
            ? obj.voices as string[]
            : null;
        const names = (obj && obj.names && typeof obj.names === 'object')
          ? obj.names as Record<string, string>
          : undefined;
        if (Array.isArray(list) && list.length) return res.json({ available: true, voices: list, names });
      } catch { /* try the next server */ }
    }
    res.json({ available: true, voices: model.fallbackVoices });
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  registerBookSync(io);

  // Unstick any audio job left mid-render by a previous crash/restart so finished
  // chapters stay playable and the rest can be resumed (non-destructive).
  await recoverInterruptedAudio(io).catch(err =>
    console.error('Failed to recover interrupted audio:', err)
  );

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
