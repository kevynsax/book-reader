import mongoose, { Schema, Document } from 'mongoose';

// A per-language, library-wide dictionary applied at read time (TTS path only).
// Currently holds acronym/version expansions (e.g. NVI -> Nova Versão Internacional).
export interface IAcronym {
  term: string;   // matched whole-word, case-sensitive (e.g. "NVI")
  say: string;    // spoken expansion
}

export interface ILexicon extends Document {
  language: string;          // ISO 639-1 (e.g. 'en', 'pt')
  acronyms: IAcronym[];
  updatedAt: Date;
}

const AcronymSchema = new Schema<IAcronym>(
  { term: { type: String, required: true }, say: { type: String, required: true } },
  { _id: false },
);

const LexiconSchema = new Schema<ILexicon>(
  {
    language: { type: String, required: true, unique: true, index: true },
    acronyms: { type: [AcronymSchema], default: [] },
  },
  { timestamps: true },
);

export const Lexicon = mongoose.model<ILexicon>('Lexicon', LexiconSchema);

// Default Bible-version acronyms seeded per language. Users can edit via the API.
const DEFAULT_ACRONYMS: Record<string, IAcronym[]> = {
  en: [
    { term: 'KJV', say: 'King James Version' },
    { term: 'NKJV', say: 'New King James Version' },
    { term: 'NIV', say: 'New International Version' },
    { term: 'ESV', say: 'English Standard Version' },
    { term: 'NLT', say: 'New Living Translation' },
    { term: 'NASB', say: 'New American Standard Bible' },
    { term: 'NRSV', say: 'New Revised Standard Version' },
    { term: 'CSB', say: 'Christian Standard Bible' },
    { term: 'ASV', say: 'American Standard Version' },
    { term: 'AMP', say: 'Amplified Bible' },
    { term: 'e.g.', say: 'for example' },
    { term: 'i.e.', say: 'that is' },
    { term: 'cf.', say: 'compare' },
    { term: '=', say: 'equals' },
  ],
  pt: [
    { term: 'NVI', say: 'Nova Versão Internacional' },
    { term: 'ARA', say: 'Almeida Revista e Atualizada' },
    { term: 'ARC', say: 'Almeida Revista e Corrigida' },
    { term: 'ACF', say: 'Almeida Corrigida Fiel' },
    { term: 'NTLH', say: 'Nova Tradução na Linguagem de Hoje' },
    { term: 'NAA', say: 'Nova Almeida Atualizada' },
    { term: 'NVT', say: 'Nova Versão Transformadora' },
    { term: 'KJA', say: 'King James Atualizada' },
    { term: 'e.g.', say: 'por exemplo' },
    { term: 'i.e.', say: 'isto é' },
    { term: 'cf.', say: 'confira' },
    { term: '=', say: 'igual a' },
  ],
};

// Seed the per-language doc when missing, and add any default terms absent from
// an existing doc (e.g. defaults shipped after first seed) without clobbering
// user edits.
export async function seedLexicons(): Promise<void> {
  for (const [language, acronyms] of Object.entries(DEFAULT_ACRONYMS)) {
    await Lexicon.updateOne(
      { language },
      { $setOnInsert: { language, acronyms } },
      { upsert: true },
    );
    const doc = await Lexicon.findOne({ language });
    if (!doc) continue;
    const have = new Set(doc.acronyms.map(a => a.term));
    const missing = acronyms.filter(a => !have.has(a.term));
    if (missing.length) {
      doc.acronyms.push(...missing);
      await doc.save();
    }
  }
}
