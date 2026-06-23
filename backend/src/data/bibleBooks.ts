// Per-language Bible book tables for read-time speech normalization.
// Each book maps spoken form (ordinal spelled out) to the tokens that may appear
// in text, including common abbreviations. The normalizer looks up the token run
// that immediately precedes a `chapter:verse` reference.

export interface Connectives {
  lang: string;
  chapter: string;
  chapters: string;
  verse: string;
  verses: string;
  through: string;
  and: string;
  page: string;
  pages: string;
  point: string;
}

export const CONNECTIVES: Record<string, Connectives> = {
  en: { lang: 'en', chapter: 'chapter', chapters: 'chapters', verse: 'verse', verses: 'verses', through: 'through', and: 'and', page: 'on the page', pages: 'on the pages', point: 'point' },
  pt: { lang: 'pt', chapter: 'capítulo', chapters: 'capítulos', verse: 'versículo', verses: 'versículos', through: 'a', and: 'e', page: 'na página', pages: 'nas páginas', point: 'vírgula' },
};

interface BookDef { say: string; aliases: string[]; }

// Normalize a token run for lookup: lowercase, drop periods, collapse spaces.
// Accents are preserved (kept significant, e.g. pt "jó" vs "joão").
export function normKey(s: string): string {
  return s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

const EN_BOOKS: BookDef[] = [
  { say: 'genesis', aliases: ['genesis', 'gen', 'ge', 'gn'] },
  { say: 'exodus', aliases: ['exodus', 'exod', 'exo', 'ex'] },
  { say: 'leviticus', aliases: ['leviticus', 'lev', 'lv'] },
  { say: 'numbers', aliases: ['numbers', 'num', 'nm', 'nu'] },
  { say: 'deuteronomy', aliases: ['deuteronomy', 'deut', 'deu', 'dt'] },
  { say: 'joshua', aliases: ['joshua', 'josh', 'jos', 'jsh'] },
  { say: 'judges', aliases: ['judges', 'judg', 'jdg', 'jg'] },
  { say: 'ruth', aliases: ['ruth', 'rth', 'ru'] },
  { say: 'first samuel', aliases: ['1 samuel', '1 sam', '1 sm', '1 sa'] },
  { say: 'second samuel', aliases: ['2 samuel', '2 sam', '2 sm', '2 sa'] },
  { say: 'first kings', aliases: ['1 kings', '1 kgs', '1 ki'] },
  { say: 'second kings', aliases: ['2 kings', '2 kgs', '2 ki'] },
  { say: 'first chronicles', aliases: ['1 chronicles', '1 chron', '1 chr', '1 ch'] },
  { say: 'second chronicles', aliases: ['2 chronicles', '2 chron', '2 chr', '2 ch'] },
  { say: 'ezra', aliases: ['ezra', 'ezr'] },
  { say: 'nehemiah', aliases: ['nehemiah', 'neh', 'ne'] },
  { say: 'esther', aliases: ['esther', 'esth', 'est'] },
  { say: 'job', aliases: ['job', 'jb'] },
  { say: 'psalms', aliases: ['psalms', 'psalm', 'psa', 'ps'] },
  { say: 'proverbs', aliases: ['proverbs', 'prov', 'prv', 'pr'] },
  { say: 'ecclesiastes', aliases: ['ecclesiastes', 'eccl', 'ecc', 'ec'] },
  { say: 'song of solomon', aliases: ['song of solomon', 'song of songs', 'song', 'sos'] },
  { say: 'isaiah', aliases: ['isaiah', 'isa', 'is'] },
  { say: 'jeremiah', aliases: ['jeremiah', 'jer', 'je'] },
  { say: 'lamentations', aliases: ['lamentations', 'lam', 'la'] },
  { say: 'ezekiel', aliases: ['ezekiel', 'ezek', 'eze', 'ezk'] },
  { say: 'daniel', aliases: ['daniel', 'dan', 'dn'] },
  { say: 'hosea', aliases: ['hosea', 'hos', 'ho'] },
  { say: 'joel', aliases: ['joel', 'joe', 'jl'] },
  { say: 'amos', aliases: ['amos', 'amo', 'am'] },
  { say: 'obadiah', aliases: ['obadiah', 'obad', 'ob'] },
  { say: 'jonah', aliases: ['jonah', 'jon', 'jnh'] },
  { say: 'micah', aliases: ['micah', 'mic', 'mc'] },
  { say: 'nahum', aliases: ['nahum', 'nah', 'na'] },
  { say: 'habakkuk', aliases: ['habakkuk', 'hab', 'hbk'] },
  { say: 'zephaniah', aliases: ['zephaniah', 'zeph', 'zep'] },
  { say: 'haggai', aliases: ['haggai', 'hag', 'hg'] },
  { say: 'zechariah', aliases: ['zechariah', 'zech', 'zec', 'zc'] },
  { say: 'malachi', aliases: ['malachi', 'mal', 'ml'] },
  { say: 'matthew', aliases: ['matthew', 'matt', 'mt'] },
  { say: 'mark', aliases: ['mark', 'mrk', 'mk'] },
  { say: 'luke', aliases: ['luke', 'luk', 'lk'] },
  { say: 'john', aliases: ['john', 'jhn', 'jn'] },
  { say: 'acts', aliases: ['acts', 'act', 'ac'] },
  { say: 'romans', aliases: ['romans', 'rom', 'rm', 'ro'] },
  { say: 'first corinthians', aliases: ['1 corinthians', '1 cor', '1 co'] },
  { say: 'second corinthians', aliases: ['2 corinthians', '2 cor', '2 co'] },
  { say: 'galatians', aliases: ['galatians', 'gal', 'ga'] },
  { say: 'ephesians', aliases: ['ephesians', 'eph'] },
  { say: 'philippians', aliases: ['philippians', 'phil', 'php', 'pp'] },
  { say: 'colossians', aliases: ['colossians', 'col'] },
  { say: 'first thessalonians', aliases: ['1 thessalonians', '1 thess', '1 thes', '1 th'] },
  { say: 'second thessalonians', aliases: ['2 thessalonians', '2 thess', '2 thes', '2 th'] },
  { say: 'first timothy', aliases: ['1 timothy', '1 tim', '1 ti'] },
  { say: 'second timothy', aliases: ['2 timothy', '2 tim', '2 ti'] },
  { say: 'titus', aliases: ['titus', 'tit'] },
  { say: 'philemon', aliases: ['philemon', 'philem', 'phlm', 'phm'] },
  { say: 'hebrews', aliases: ['hebrews', 'heb'] },
  { say: 'james', aliases: ['james', 'jas', 'jm'] },
  { say: 'first peter', aliases: ['1 peter', '1 pet', '1 pe'] },
  { say: 'second peter', aliases: ['2 peter', '2 pet', '2 pe'] },
  { say: 'first john', aliases: ['1 john', '1 jhn', '1 jn'] },
  { say: 'second john', aliases: ['2 john', '2 jhn', '2 jn'] },
  { say: 'third john', aliases: ['3 john', '3 jhn', '3 jn'] },
  { say: 'jude', aliases: ['jude', 'jud', 'jd'] },
  { say: 'revelation', aliases: ['revelation', 'rev', 'rv', 're'] },
];

const PT_BOOKS: BookDef[] = [
  { say: 'gênesis', aliases: ['gênesis', 'gn', 'gen'] },
  { say: 'êxodo', aliases: ['êxodo', 'ex', 'exo'] },
  { say: 'levítico', aliases: ['levítico', 'lv', 'lev'] },
  { say: 'números', aliases: ['números', 'nm', 'num'] },
  { say: 'deuteronômio', aliases: ['deuteronômio', 'dt', 'deut'] },
  { say: 'josué', aliases: ['josué', 'js', 'jos'] },
  { say: 'juízes', aliases: ['juízes', 'jz', 'juí'] },
  { say: 'rute', aliases: ['rute', 'rt'] },
  { say: 'primeira samuel', aliases: ['1 samuel', '1 sm', '1 sam'] },
  { say: 'segunda samuel', aliases: ['2 samuel', '2 sm', '2 sam'] },
  { say: 'primeira reis', aliases: ['1 reis', '1 rs', '1 re'] },
  { say: 'segunda reis', aliases: ['2 reis', '2 rs', '2 re'] },
  { say: 'primeira crônicas', aliases: ['1 crônicas', '1 cr'] },
  { say: 'segunda crônicas', aliases: ['2 crônicas', '2 cr'] },
  { say: 'esdras', aliases: ['esdras', 'ed', 'esd'] },
  { say: 'neemias', aliases: ['neemias', 'ne', 'nee'] },
  { say: 'ester', aliases: ['ester', 'et', 'est'] },
  { say: 'jó', aliases: ['jó', 'job'] },
  { say: 'salmos', aliases: ['salmos', 'salmo', 'sl', 'sal'] },
  { say: 'provérbios', aliases: ['provérbios', 'pv', 'prov'] },
  { say: 'eclesiastes', aliases: ['eclesiastes', 'ec', 'ecl'] },
  { say: 'cantares de salomão', aliases: ['cantares de salomão', 'cânticos', 'cantares', 'ct'] },
  { say: 'isaías', aliases: ['isaías', 'is', 'isa'] },
  { say: 'jeremias', aliases: ['jeremias', 'jr', 'jer'] },
  { say: 'lamentações', aliases: ['lamentações', 'lm', 'lam'] },
  { say: 'ezequiel', aliases: ['ezequiel', 'ez', 'eze'] },
  { say: 'daniel', aliases: ['daniel', 'dn', 'dan'] },
  { say: 'oseias', aliases: ['oseias', 'os'] },
  { say: 'joel', aliases: ['joel', 'jl'] },
  { say: 'amós', aliases: ['amós', 'am'] },
  { say: 'obadias', aliases: ['obadias', 'ob'] },
  { say: 'jonas', aliases: ['jonas', 'jn', 'jon'] },
  { say: 'miqueias', aliases: ['miqueias', 'mq'] },
  { say: 'naum', aliases: ['naum', 'na'] },
  { say: 'habacuque', aliases: ['habacuque', 'hc', 'hab'] },
  { say: 'sofonias', aliases: ['sofonias', 'sf'] },
  { say: 'ageu', aliases: ['ageu', 'ag'] },
  { say: 'zacarias', aliases: ['zacarias', 'zc'] },
  { say: 'malaquias', aliases: ['malaquias', 'ml'] },
  { say: 'mateus', aliases: ['mateus', 'mt'] },
  { say: 'marcos', aliases: ['marcos', 'mc'] },
  { say: 'lucas', aliases: ['lucas', 'lc'] },
  { say: 'joão', aliases: ['joão', 'jo', 'jô'] },
  { say: 'atos', aliases: ['atos', 'at'] },
  { say: 'romanos', aliases: ['romanos', 'rm'] },
  { say: 'primeira coríntios', aliases: ['1 coríntios', '1 co', '1 cor'] },
  { say: 'segunda coríntios', aliases: ['2 coríntios', '2 co', '2 cor'] },
  { say: 'gálatas', aliases: ['gálatas', 'gl'] },
  { say: 'efésios', aliases: ['efésios', 'ef'] },
  { say: 'filipenses', aliases: ['filipenses', 'fp'] },
  { say: 'colossenses', aliases: ['colossenses', 'cl'] },
  { say: 'primeira tessalonicenses', aliases: ['1 tessalonicenses', '1 ts', '1 tes'] },
  { say: 'segunda tessalonicenses', aliases: ['2 tessalonicenses', '2 ts', '2 tes'] },
  { say: 'primeira timóteo', aliases: ['1 timóteo', '1 tm'] },
  { say: 'segunda timóteo', aliases: ['2 timóteo', '2 tm'] },
  { say: 'tito', aliases: ['tito', 'tt'] },
  { say: 'filemom', aliases: ['filemom', 'fm'] },
  { say: 'hebreus', aliases: ['hebreus', 'hb', 'heb'] },
  { say: 'tiago', aliases: ['tiago', 'tg'] },
  { say: 'primeira pedro', aliases: ['1 pedro', '1 pe'] },
  { say: 'segunda pedro', aliases: ['2 pedro', '2 pe'] },
  { say: 'primeira joão', aliases: ['1 joão', '1 jo'] },
  { say: 'segunda joão', aliases: ['2 joão', '2 jo'] },
  { say: 'terceira joão', aliases: ['3 joão', '3 jo'] },
  { say: 'judas', aliases: ['judas', 'jd'] },
  { say: 'apocalipse', aliases: ['apocalipse', 'ap', 'apo'] },
];

function buildMap(defs: BookDef[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const d of defs) for (const a of d.aliases) m.set(normKey(a), d.say);
  return m;
}

// Lookup map per language: normalized token -> spoken book name.
export const BIBLE_BOOKS: Record<string, Map<string, string>> = {
  en: buildMap(EN_BOOKS),
  pt: buildMap(PT_BOOKS),
};

// OCR-detected language strings vary ("pt-br", "portuguese", "português"); map
// the common variants onto the supported ISO code before table lookup.
const LANG_ALIASES: Record<string, string> = {
  por: 'pt', 'pt-br': 'pt', 'pt-pt': 'pt', portuguese: 'pt', 'português': 'pt', portugues: 'pt',
  eng: 'en', 'en-us': 'en', 'en-gb': 'en', english: 'en',
};

// Resolve a detected language to a supported table key, falling back to English.
export function resolveLang(language: string | undefined): string {
  if (!language) return 'en';
  const lc = language.toLowerCase();
  const canonical = BIBLE_BOOKS[lc] ? lc : (LANG_ALIASES[lc] ?? lc.split(/[-_]/)[0]);
  return BIBLE_BOOKS[canonical] ? canonical : 'en';
}

// Resolve language to a supported table, falling back to English.
export function bookTableFor(language: string): { books: Map<string, string>; conn: Connectives } {
  const lang = resolveLang(language);
  return { books: BIBLE_BOOKS[lang], conn: CONNECTIVES[lang] };
}
