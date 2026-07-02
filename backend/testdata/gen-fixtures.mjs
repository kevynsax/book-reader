// Generates golden fixtures from the Node implementation for the Go port's
// parity tests. Run from backend/: node ../backend-go/testdata/gen-fixtures.mjs
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, '../../backend');

// Compile the needed TS sources on the fly via tsx's ESM loader.
const { BIBLE_BOOKS, CONNECTIVES, resolveLang } = await import(`${backend}/src/data/bibleBooks.ts`);
const { numberToWords } = await import(`${backend}/src/data/numberWords.ts`);
const {
  expandReferences, expandBareReferences, expandVerseRefs, expandPages,
  expandChapters, expandParenRanges, expandPairedBooks, expandBookRefs,
  expandBareBooks, expandLabeledRanges, expandNumbers, expandAcronyms,
} = await import(`${backend}/src/services/textNormalizer.ts`);
const { reflowSentences, isTitle } = await import(`${backend}/src/lib/sentences.ts`);
const { wordSimilarity, normalizeWords } = await import(`${backend}/src/lib/verify.ts`);
const { sanitizePageText } = await import(`${backend}/src/lib/sanitize.ts`);

const DEFAULT_ACRONYMS = {
  en: [
    { term: 'KJV', say: 'King James Version' }, { term: 'NKJV', say: 'New King James Version' },
    { term: 'NIV', say: 'New International Version' }, { term: 'ESV', say: 'English Standard Version' },
    { term: 'NLT', say: 'New Living Translation' }, { term: 'NASB', say: 'New American Standard Bible' },
    { term: 'NRSV', say: 'New Revised Standard Version' }, { term: 'CSB', say: 'Christian Standard Bible' },
    { term: 'ASV', say: 'American Standard Version' }, { term: 'AMP', say: 'Amplified Bible' },
    { term: 'e.g.', say: 'for example' }, { term: 'i.e.', say: 'that is' },
    { term: 'cf.', say: 'compare' }, { term: '=', say: 'equals' },
  ],
  pt: [
    { term: 'NVI', say: 'Nova Versão Internacional' }, { term: 'ARA', say: 'Almeida Revista e Atualizada' },
    { term: 'ARC', say: 'Almeida Revista e Corrigida' }, { term: 'ACF', say: 'Almeida Corrigida Fiel' },
    { term: 'NTLH', say: 'Nova Tradução na Linguagem de Hoje' }, { term: 'NAA', say: 'Nova Almeida Atualizada' },
    { term: 'NVT', say: 'Nova Versão Transformadora' }, { term: 'KJA', say: 'King James Atualizada' },
    { term: 'e.g.', say: 'por exemplo' }, { term: 'i.e.', say: 'isto é' },
    { term: 'cf.', say: 'confira' }, { term: '=', say: 'igual a' },
  ],
};

// Mirrors normalizeForSpeech but with acronyms passed explicitly (no DB).
function normalize(text, language) {
  const lang = resolveLang(language);
  let out = expandReferences(text, BIBLE_BOOKS[lang], CONNECTIVES[lang]);
  out = expandVerseRefs(out, CONNECTIVES[lang]);
  out = expandPages(out, CONNECTIVES[lang]);
  out = expandChapters(out, CONNECTIVES[lang]);
  out = expandPairedBooks(out, BIBLE_BOOKS[lang], CONNECTIVES[lang]);
  out = expandBookRefs(out, BIBLE_BOOKS[lang], CONNECTIVES[lang]);
  out = expandBareBooks(out, BIBLE_BOOKS[lang], CONNECTIVES[lang]);
  out = expandBareReferences(out, CONNECTIVES[lang]);
  out = expandLabeledRanges(out, CONNECTIVES[lang]);
  out = expandParenRanges(out, CONNECTIVES[lang]);
  out = expandAcronyms(out, DEFAULT_ACRONYMS[lang] ?? []);
  out = expandNumbers(out, CONNECTIVES[lang]);
  return out;
}

const normalizeCases = [
  ['en', 'See Genesis 1:1 for the beginning.'],
  ['en', 'Compare 1 Cor 13:4-7 and 2 Sam 11:2, 4, 26-27.'],
  ['en', 'As shown in Rom 8:28–30, all things work together.'],
  ['en', 'Read Psalm 23:1-6, then pp. 119-176 in the commentary.'],
  ['en', 'In ch. 38 the LORD answers Job. See also chs. 6-9, 12.'],
  ['en', 'vv. 2, 3, 21 and 23 make the point (see v. 5).'],
  ['en', 'The books of 1 and 2 Samuel form one narrative.'],
  ['en', 'Gen 24 records the marriage; Luke 1 – 2 the birth.'],
  ['en', 'The story of 2 Samuel is about David.'],
  ['en', 'It costs 2.3 million dollars, about 1,000 per unit.'],
  ['en', 'In 1994 there were 25 churches (42 – 45).'],
  ['en', 'chapters 42 – 45 discuss restoration.'],
  ['en', 'The NIV and ESV translate it differently, e.g. as "love".'],
  ['en', 'x=5 means x equals five.'],
  ['en', 'See 3:16 for the gospel in miniature.'],
  ['en', 'He waited 3 days and 40 nights, cf. the flood.'],
  ['en', 'A job 1 means work; Job 1 means scripture.'],
  ['en', 'version v1.5 and the 1st item stay untouched, h2o too.'],
  ['en', 'Isaiah 53 and Isa 61:1-3 speak of the servant.'],
  ['en', 'Some numbers: 0, 7, 19, 20, 21, 100, 101, 999, 1000, 2500, 999999, 1000000.'],
  ['pt', 'Veja Gênesis 1.1 no começo.'],
  ['pt', 'Compare 1 Co 13.4-7 e 2 Sm 11.2, 4, 26-27.'],
  ['pt', 'Leia o Salmo 23.1-6 e depois João 3.16.'],
  ['pt', 'Os livros de 1 e 2 Samuel formam uma narrativa.'],
  ['pt', 'Custa 2,5 milhões, cerca de 1.000 por unidade.'],
  ['pt', 'capítulos 42 – 45 tratam da restauração.'],
  ['pt', 'A NVI e a ARA traduzem diferente, i.e. de outra forma.'],
  ['pt', 'Números soltos: 0, 7, 19, 21, 100, 101, 345, 999, 1000, 2500, 550055.'],
  ['pt', 'Em 2 Reis 2.23 e também 2 Rs 4.1 há milagres.'],
  ['pt', 'O livro de Jó fala de sofrimento; jó 3 não conta.'],
  ['unknown', 'Genesis 1:1 with unknown language falls back to English, 42 too.'],
  ['pt-br', 'Marcos 4.35 na língua pt-br.'],
];

const reflowCases = [
  'The quick brown fox. It jumped over the dog.\nAnd then it ran away!',
  'A hard\nwrapped line that continues\non the next line. Second sentence here.',
  'He said "Hello." Then left.\n\nNew paragraph starts. (A short aside.) More text.',
  'See ch. 38 for details. It continues.',
  'Wait... what happened? The OCR spaced dots . . . remain inline.',
  'A sentence with (a bracketed aside that is quite short) inside it. Next one.',
  'Title Line\n\nBody text follows here. And more. And more still?',
  'Ele disse: "Olá!" E saiu. (Um aparte curto.) Fim da história…',
  'Verses vv. 6-9 stay glued. As do pp. 12-14 and vol. 3 references.',
];

const similarityCases = [
  ['Hello world, this is a test.', 'hello world this is a test'],
  ['Genesis chapter one verse one', 'genesis chapter 1 verse 1'],
  ['completely different text here', 'nothing alike whatsoever friend'],
  ['Coração de João', 'coracao de joao'],
  ['', ''],
  ['something', ''],
];

const sanitizeCases = [
  '```json\n{"language":"en","content":"Hello world"}\n```',
  '{"language":"pt","content":"Linha um\\nLinha dois"}',
  'Plain text stays as is.',
  '{"content": "Broken json without close',
  '  {"language":"en","content":"trimmed"}  ',
];

const numberCases = [];
for (const lang of ['en', 'pt']) {
  for (const n of [0, 1, 7, 13, 19, 20, 21, 42, 99, 100, 101, 110, 199, 200, 345, 999, 1000, 1001, 1100, 2500, 2550, 100000, 550055, 999999, 1000000, 1000001, 2000000, 2500000, 999999999, 1000000000]) {
    numberCases.push({ lang, n, words: numberToWords(n, lang) });
  }
}

const out = {
  normalize: normalizeCases.map(([lang, text]) => ({ lang, text, want: normalize(text, lang) })),
  reflow: reflowCases.map(text => ({ text, want: reflowSentences(text) })),
  isTitle: ['Chapter One', 'A somewhat longer line of text that runs on', 'One', '', 'Five words exactly in here'].map(t => ({ text: t, want: isTitle(t, 5) })),
  similarity: similarityCases.map(([a, b]) => ({ a, b, want: wordSimilarity(a, b), words: normalizeWords(a) })),
  sanitize: sanitizeCases.map(t => ({ text: t, want: sanitizePageText(t) })),
  numbers: numberCases,
};

writeFileSync(path.join(here, 'fixtures.json'), JSON.stringify(out, null, 2));
console.log('fixtures written:',
  Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
