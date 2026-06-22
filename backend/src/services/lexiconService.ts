import { Lexicon, IAcronym } from '../models/Lexicon.js';

// In-memory cache of acronym lists (single backend process). Invalidated by the
// lexicon PUT route after edits.
const cache = new Map<string, IAcronym[]>();

export async function getAcronyms(language: string): Promise<IAcronym[]> {
  const cached = cache.get(language);
  if (cached) return cached;
  const doc = await Lexicon.findOne({ language }).lean();
  const acronyms = doc?.acronyms ?? [];
  cache.set(language, acronyms);
  return acronyms;
}

export function invalidateLexicon(language?: string): void {
  if (language) cache.delete(language);
  else cache.clear();
}
