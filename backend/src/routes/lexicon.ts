import express from 'express';
import { Lexicon, IAcronym } from '../models/Lexicon.js';
import { invalidateLexicon } from '../services/lexiconService.js';

// Library-wide, per-language read-time dictionary (currently acronym/version
// expansions). Bible book-name expansion is algorithmic and not stored here.
export function lexiconRouter() {
  const router = express.Router();

  // List all language dictionaries.
  router.get('/', async (_req, res) => {
    const docs = await Lexicon.find().sort({ language: 1 }).lean();
    res.json(docs);
  });

  // Get one language's dictionary.
  router.get('/:language', async (req, res) => {
    const doc = await Lexicon.findOne({ language: req.params.language }).lean();
    if (!doc) return res.status(404).json({ error: 'not found' });
    res.json(doc);
  });

  // Replace a language's acronym list.
  router.put('/:language', async (req, res) => {
    const { language } = req.params;
    const raw = (req.body?.acronyms ?? []) as unknown;
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'acronyms must be an array' });

    const acronyms: IAcronym[] = [];
    for (const a of raw) {
      const term = typeof a?.term === 'string' ? a.term.trim() : '';
      const say = typeof a?.say === 'string' ? a.say.trim() : '';
      if (term && say) acronyms.push({ term, say });
    }

    const doc = await Lexicon.findOneAndUpdate(
      { language },
      { $set: { acronyms } },
      { upsert: true, new: true },
    ).lean();
    invalidateLexicon(language);
    res.json(doc);
  });

  return router;
}
