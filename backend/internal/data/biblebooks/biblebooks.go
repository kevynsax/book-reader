// Package biblebooks holds the per-language Bible book tables for read-time
// speech normalization. Each book maps spoken form (ordinal spelled out) to
// the tokens that may appear in text, including common abbreviations.
package biblebooks

import (
	"regexp"
	"strings"
)

type Connectives struct {
	Lang     string
	Chapter  string
	Chapters string
	Verse    string
	Verses   string
	Through  string
	And      string
	Page     string
	Pages    string
	Point    string
}

var CONNECTIVES = map[string]Connectives{
	"en": {Lang: "en", Chapter: "chapter", Chapters: "chapters", Verse: "verse", Verses: "verses", Through: "through", And: "and", Page: "on the page", Pages: "on the pages", Point: "point"},
	"pt": {Lang: "pt", Chapter: "capítulo", Chapters: "capítulos", Verse: "versículo", Verses: "versículos", Through: "a", And: "e", Page: "na página", Pages: "nas páginas", Point: "vírgula"},
}

type bookDef struct {
	say     string
	aliases []string
}

var spaces = regexp.MustCompile(`\s+`)

// NormKey normalizes a token run for lookup: lowercase, drop periods, collapse
// spaces. Accents are preserved (kept significant, e.g. pt "jó" vs "joão").
func NormKey(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, ".", "")
	return strings.TrimSpace(spaces.ReplaceAllString(s, " "))
}

var enBooks = []bookDef{
	{"genesis", []string{"genesis", "gen", "ge", "gn"}},
	{"exodus", []string{"exodus", "exod", "exo", "ex"}},
	{"leviticus", []string{"leviticus", "lev", "lv"}},
	{"numbers", []string{"numbers", "num", "nm", "nu"}},
	{"deuteronomy", []string{"deuteronomy", "deut", "deu", "dt"}},
	{"joshua", []string{"joshua", "josh", "jos", "jsh"}},
	{"judges", []string{"judges", "judg", "jdg", "jg"}},
	{"ruth", []string{"ruth", "rth", "ru"}},
	{"first samuel", []string{"1 samuel", "1 sam", "1 sm", "1 sa"}},
	{"second samuel", []string{"2 samuel", "2 sam", "2 sm", "2 sa"}},
	{"first kings", []string{"1 kings", "1 kgs", "1 ki"}},
	{"second kings", []string{"2 kings", "2 kgs", "2 ki"}},
	{"first chronicles", []string{"1 chronicles", "1 chron", "1 chr", "1 ch"}},
	{"second chronicles", []string{"2 chronicles", "2 chron", "2 chr", "2 ch"}},
	{"ezra", []string{"ezra", "ezr"}},
	{"nehemiah", []string{"nehemiah", "neh", "ne"}},
	{"esther", []string{"esther", "esth", "est"}},
	{"job", []string{"job", "jb"}},
	{"psalms", []string{"psalms", "psalm", "psa", "ps"}},
	{"proverbs", []string{"proverbs", "prov", "prv", "pr"}},
	{"ecclesiastes", []string{"ecclesiastes", "eccl", "ecc", "ec"}},
	{"song of solomon", []string{"song of solomon", "song of songs", "song", "sos"}},
	{"isaiah", []string{"isaiah", "isa", "is"}},
	{"jeremiah", []string{"jeremiah", "jer", "je"}},
	{"lamentations", []string{"lamentations", "lam", "la"}},
	{"ezekiel", []string{"ezekiel", "ezek", "eze", "ezk"}},
	{"daniel", []string{"daniel", "dan", "dn"}},
	{"hosea", []string{"hosea", "hos", "ho"}},
	{"joel", []string{"joel", "joe", "jl"}},
	{"amos", []string{"amos", "amo", "am"}},
	{"obadiah", []string{"obadiah", "obad", "ob"}},
	{"jonah", []string{"jonah", "jon", "jnh"}},
	{"micah", []string{"micah", "mic", "mc"}},
	{"nahum", []string{"nahum", "nah", "na"}},
	{"habakkuk", []string{"habakkuk", "hab", "hbk"}},
	{"zephaniah", []string{"zephaniah", "zeph", "zep"}},
	{"haggai", []string{"haggai", "hag", "hg"}},
	{"zechariah", []string{"zechariah", "zech", "zec", "zc"}},
	{"malachi", []string{"malachi", "mal", "ml"}},
	{"matthew", []string{"matthew", "matt", "mt"}},
	{"mark", []string{"mark", "mrk", "mk"}},
	{"luke", []string{"luke", "luk", "lk"}},
	{"john", []string{"john", "jhn", "jn"}},
	{"acts", []string{"acts", "act", "ac"}},
	{"romans", []string{"romans", "rom", "rm", "ro"}},
	{"first corinthians", []string{"1 corinthians", "1 cor", "1 co"}},
	{"second corinthians", []string{"2 corinthians", "2 cor", "2 co"}},
	{"galatians", []string{"galatians", "gal", "ga"}},
	{"ephesians", []string{"ephesians", "eph"}},
	{"philippians", []string{"philippians", "phil", "php", "pp"}},
	{"colossians", []string{"colossians", "col"}},
	{"first thessalonians", []string{"1 thessalonians", "1 thess", "1 thes", "1 th"}},
	{"second thessalonians", []string{"2 thessalonians", "2 thess", "2 thes", "2 th"}},
	{"first timothy", []string{"1 timothy", "1 tim", "1 ti"}},
	{"second timothy", []string{"2 timothy", "2 tim", "2 ti"}},
	{"titus", []string{"titus", "tit"}},
	{"philemon", []string{"philemon", "philem", "phlm", "phm"}},
	{"hebrews", []string{"hebrews", "heb"}},
	{"james", []string{"james", "jas", "jm"}},
	{"first peter", []string{"1 peter", "1 pet", "1 pe"}},
	{"second peter", []string{"2 peter", "2 pet", "2 pe"}},
	{"first john", []string{"1 john", "1 jhn", "1 jn"}},
	{"second john", []string{"2 john", "2 jhn", "2 jn"}},
	{"third john", []string{"3 john", "3 jhn", "3 jn"}},
	{"jude", []string{"jude", "jud", "jd"}},
	{"revelation", []string{"revelation", "rev", "rv", "re"}},
}

var ptBooks = []bookDef{
	{"gênesis", []string{"gênesis", "gn", "gen"}},
	{"êxodo", []string{"êxodo", "ex", "exo"}},
	{"levítico", []string{"levítico", "lv", "lev"}},
	{"números", []string{"números", "nm", "num"}},
	{"deuteronômio", []string{"deuteronômio", "dt", "deut"}},
	{"josué", []string{"josué", "js", "jos"}},
	{"juízes", []string{"juízes", "jz", "juí"}},
	{"rute", []string{"rute", "rt"}},
	{"primeira samuel", []string{"1 samuel", "1 sm", "1 sam"}},
	{"segunda samuel", []string{"2 samuel", "2 sm", "2 sam"}},
	{"primeira reis", []string{"1 reis", "1 rs", "1 re"}},
	{"segunda reis", []string{"2 reis", "2 rs", "2 re"}},
	{"primeira crônicas", []string{"1 crônicas", "1 cr"}},
	{"segunda crônicas", []string{"2 crônicas", "2 cr"}},
	{"esdras", []string{"esdras", "ed", "esd"}},
	{"neemias", []string{"neemias", "ne", "nee"}},
	{"ester", []string{"ester", "et", "est"}},
	{"jó", []string{"jó", "job"}},
	{"salmos", []string{"salmos", "salmo", "sl", "sal"}},
	{"provérbios", []string{"provérbios", "pv", "prov"}},
	{"eclesiastes", []string{"eclesiastes", "ec", "ecl"}},
	{"cantares de salomão", []string{"cantares de salomão", "cânticos", "cantares", "ct"}},
	{"isaías", []string{"isaías", "is", "isa"}},
	{"jeremias", []string{"jeremias", "jr", "jer"}},
	{"lamentações", []string{"lamentações", "lm", "lam"}},
	{"ezequiel", []string{"ezequiel", "ez", "eze"}},
	{"daniel", []string{"daniel", "dn", "dan"}},
	{"oseias", []string{"oseias", "os"}},
	{"joel", []string{"joel", "jl"}},
	{"amós", []string{"amós", "am"}},
	{"obadias", []string{"obadias", "ob"}},
	{"jonas", []string{"jonas", "jn", "jon"}},
	{"miqueias", []string{"miqueias", "mq"}},
	{"naum", []string{"naum", "na"}},
	{"habacuque", []string{"habacuque", "hc", "hab"}},
	{"sofonias", []string{"sofonias", "sf"}},
	{"ageu", []string{"ageu", "ag"}},
	{"zacarias", []string{"zacarias", "zc"}},
	{"malaquias", []string{"malaquias", "ml"}},
	{"mateus", []string{"mateus", "mt"}},
	{"marcos", []string{"marcos", "mc"}},
	{"lucas", []string{"lucas", "lc"}},
	{"joão", []string{"joão", "jo", "jô"}},
	{"atos", []string{"atos", "at"}},
	{"romanos", []string{"romanos", "rm"}},
	{"primeira coríntios", []string{"1 coríntios", "1 co", "1 cor"}},
	{"segunda coríntios", []string{"2 coríntios", "2 co", "2 cor"}},
	{"gálatas", []string{"gálatas", "gl"}},
	{"efésios", []string{"efésios", "ef"}},
	{"filipenses", []string{"filipenses", "fp"}},
	{"colossenses", []string{"colossenses", "cl"}},
	{"primeira tessalonicenses", []string{"1 tessalonicenses", "1 ts", "1 tes"}},
	{"segunda tessalonicenses", []string{"2 tessalonicenses", "2 ts", "2 tes"}},
	{"primeira timóteo", []string{"1 timóteo", "1 tm"}},
	{"segunda timóteo", []string{"2 timóteo", "2 tm"}},
	{"tito", []string{"tito", "tt"}},
	{"filemom", []string{"filemom", "fm"}},
	{"hebreus", []string{"hebreus", "hb", "heb"}},
	{"tiago", []string{"tiago", "tg"}},
	{"primeira pedro", []string{"1 pedro", "1 pe"}},
	{"segunda pedro", []string{"2 pedro", "2 pe"}},
	{"primeira joão", []string{"1 joão", "1 jo"}},
	{"segunda joão", []string{"2 joão", "2 jo"}},
	{"terceira joão", []string{"3 joão", "3 jo"}},
	{"judas", []string{"judas", "jd"}},
	{"apocalipse", []string{"apocalipse", "ap", "apo"}},
}

func buildMap(defs []bookDef) map[string]string {
	m := map[string]string{}
	for _, d := range defs {
		for _, a := range d.aliases {
			m[NormKey(a)] = d.say
		}
	}
	return m
}

// BibleBooks maps, per language: normalized token -> spoken book name.
var BibleBooks = map[string]map[string]string{
	"en": buildMap(enBooks),
	"pt": buildMap(ptBooks),
}

// OCR-detected language strings vary; map common variants onto the supported
// ISO code before table lookup.
var langAliases = map[string]string{
	"por": "pt", "pt-br": "pt", "pt-pt": "pt", "portuguese": "pt", "português": "pt", "portugues": "pt",
	"eng": "en", "en-us": "en", "en-gb": "en", "english": "en",
}

// ResolveLang resolves a detected language to a supported table key, falling
// back to English.
func ResolveLang(language string) string {
	if language == "" {
		return "en"
	}
	lc := strings.ToLower(language)
	canonical := lc
	if _, ok := BibleBooks[lc]; !ok {
		if alias, ok := langAliases[lc]; ok {
			canonical = alias
		} else {
			canonical = strings.FieldsFunc(lc, func(r rune) bool { return r == '-' || r == '_' })[0]
		}
	}
	if _, ok := BibleBooks[canonical]; ok {
		return canonical
	}
	return "en"
}
