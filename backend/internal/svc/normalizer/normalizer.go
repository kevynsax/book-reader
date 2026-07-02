// Package normalizer rewrites text into a more speakable form for TTS.
// Read-time only — never mutates stored OCR/edited text. Port of
// services/textNormalizer.ts; the lookbehind/lookahead-heavy patterns need
// regexp2 (stdlib RE2 has no lookarounds).
package normalizer

import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"github.com/dlclark/regexp2"

	"github.com/kevynsax/book-reader/backend/internal/data/biblebooks"
	"github.com/kevynsax/book-reader/backend/internal/data/numberwords"
	"github.com/kevynsax/book-reader/backend/internal/model"
)

var roman = map[string]string{"i": "1", "ii": "2", "iii": "3"}

// The chapter–verse separator differs by language: English uses a colon
// ("2:3"), Portuguese a period ("2.3"). Only the book-anchored refRe accepts
// the period — a known book name gates it.
func cvSep(conn biblebooks.Connectives) string {
	if conn.Lang == "pt" {
		return "[:.]"
	}
	return ":"
}

var (
	refReCache   sync.Map // lang -> *regexp2.Regexp
	pairedCache  sync.Map // lang -> *regexp2.Regexp
	labeledCache sync.Map // lang -> *regexp2.Regexp
	acronymCache sync.Map // joined terms -> *regexp2.Regexp
)

func cached(cache *sync.Map, key string, build func() *regexp2.Regexp) *regexp2.Regexp {
	if v, ok := cache.Load(key); ok {
		return v.(*regexp2.Regexp)
	}
	re := build()
	cache.Store(key, re)
	return re
}

// Matches a Bible reference: optional book number (1/2/3 or I/II/III), 1-3
// book words, then chapter:verse with an optional range and comma tail. The
// required `\d+<sep>\d+` keeps short abbreviations from matching prose.
func refRe(conn biblebooks.Connectives) *regexp2.Regexp {
	return cached(&refReCache, conn.Lang, func() *regexp2.Regexp {
		return regexp2.MustCompile(
			`(?<![\p{L}\d])(?:([123]|i{1,3})(?![\p{L}])\s*)?((?:\p{L}[\p{L}.]*)(?:\s+\p{L}[\p{L}.]*){0,2})\s+(\d+)`+cvSep(conn)+`(\d+)(?:\s*[-–—]\s*(\d+))?((?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)+)?`,
			regexp2.IgnoreCase)
	})
}

// group returns the numbered capture's text, "" when it didn't participate.
func group(m regexp2.Match, i int) string {
	g := m.GroupByNumber(i)
	if g == nil || len(g.Captures) == 0 {
		return ""
	}
	return g.String()
}

func replaceAll(re *regexp2.Regexp, text string, fn func(m regexp2.Match) string) string {
	out, err := re.ReplaceFunc(text, fn, -1, -1)
	if err != nil {
		return text
	}
	return out
}

type bookHit struct {
	say  string
	take int
}

// matchBook finds the longest book name that forms a suffix of the captured
// words.
func matchBook(books map[string]string, numArabic string, words []string) *bookHit {
	for take := len(words); take >= 1; take-- {
		suffix := strings.Join(words[len(words)-take:], " ")
		key := biblebooks.NormKey(suffix)
		if numArabic != "" {
			key = numArabic + " " + key
		}
		if say, ok := books[key]; ok {
			return &bookHit{say: say, take: take}
		}
	}
	return nil
}

// rangeJoin reads a dash range of two consecutive numbers ("6-7") as "6 and
// 7"; a wider range ("6-9") stays "6 through 9".
func rangeJoin(conn biblebooks.Connectives, a, b string) string {
	na, errA := strconv.ParseInt(a, 10, 64)
	nb, errB := strconv.ParseInt(b, 10, 64)
	if errA == nil && errB == nil && nb-na == 1 {
		return conn.And
	}
	return conn.Through
}

// sayNum spells reference numbers in full so the read form differs visibly
// from the source digits in the review diff.
func sayNum(conn biblebooks.Connectives, n string) string {
	v, err := strconv.ParseInt(n, 10, 64)
	if err != nil {
		return n
	}
	return numberwords.NumberToWords(v, conn.Lang)
}

// joinList joins spoken items comma-separated with the connective before the
// last ("2, 3, 21 and 23"; "6 and 7" for a pair).
func joinList(conn biblebooks.Connectives, parts []string) string {
	if len(parts) == 0 {
		return ""
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " " + conn.And + " " + parts[len(parts)-1]
}

var restItemRe = regexp.MustCompile(`^(\d+)(?:\s*[-–—]\s*(\d+))?$`)

// spokenParts turns a leading number, an optional "a-b" range, and an optional
// comma tail into spoken, spelled-out items.
func spokenParts(conn biblebooks.Connectives, v1, v2, rest string) []string {
	part := func(a, b string) string {
		if b != "" {
			return sayNum(conn, a) + " " + rangeJoin(conn, a, b) + " " + sayNum(conn, b)
		}
		return sayNum(conn, a)
	}
	parts := []string{part(v1, v2)}
	if rest != "" {
		for _, item := range strings.Split(rest, ",") {
			if m := restItemRe.FindStringSubmatch(strings.TrimSpace(item)); m != nil {
				parts = append(parts, part(m[1], m[2]))
			}
		}
	}
	return parts
}

// speakNumbers renders spoken parts prefixed by a singular/plural label
// ("verse 5", "verses 2, 3, 21 and 23").
func speakNumbers(conn biblebooks.Connectives, singular, plural, v1, v2, rest string, forcePlural bool) string {
	parts := spokenParts(conn, v1, v2, rest)
	label := singular
	if forcePlural || v2 != "" || len(parts) > 1 {
		label = plural
	}
	return label + " " + joinList(conn, parts)
}

func speakVerses(conn biblebooks.Connectives, v1, v2, rest string, forcePlural bool) string {
	return speakNumbers(conn, conn.Verse, conn.Verses, v1, v2, rest, forcePlural)
}

func ExpandReferences(text string, books map[string]string, conn biblebooks.Connectives) string {
	return replaceAll(refRe(conn), text, func(m regexp2.Match) string {
		num, wordsRaw := group(m, 1), group(m, 2)
		chap, v1, v2, rest := group(m, 3), group(m, 4), group(m, 5), group(m, 6)
		numArabic := ""
		if num != "" {
			numArabic = num
			if r, ok := roman[strings.ToLower(num)]; ok {
				numArabic = r
			}
		}
		words := strings.Fields(strings.TrimSpace(wordsRaw))
		hit := matchBook(books, numArabic, words)
		if hit == nil {
			return m.String() // not a known book -> leave untouched
		}
		pre := ""
		if preamble := words[:len(words)-hit.take]; len(preamble) > 0 {
			pre = strings.Join(preamble, " ") + " "
		}
		return pre + hit.say + " " + conn.Chapter + " " + sayNum(conn, chap) + " " + speakVerses(conn, v1, v2, rest, false)
	})
}

var bareRefRe = regexp2.MustCompile(
	`(?<![\p{L}\d:])(\d+):(\d+)(?:\s*[-–—]\s*(\d+))?((?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)+)?(?![:\d])`,
	regexp2.IgnoreCase)

func ExpandBareReferences(text string, conn biblebooks.Connectives) string {
	return replaceAll(bareRefRe, text, func(m regexp2.Match) string {
		chap, v1, v2, rest := group(m, 1), group(m, 2), group(m, 3), group(m, 4)
		return conn.Chapter + " " + sayNum(conn, chap) + " " + speakVerses(conn, v1, v2, rest, false)
	})
}

// ECMAScript mode keeps \b's ASCII \w semantics identical to JS for the
// abbreviation-anchored patterns.
var verseRe = regexp2.MustCompile(
	`\b(vv?)\.\s*(\d+)(?:\s*[-–—]\s*(\d+))?((?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)+)?`,
	regexp2.IgnoreCase|regexp2.ECMAScript)

func ExpandVerseRefs(text string, conn biblebooks.Connectives) string {
	return replaceAll(verseRe, text, func(m regexp2.Match) string {
		tok := group(m, 1)
		return speakVerses(conn, group(m, 2), group(m, 3), group(m, 4), strings.ToLower(tok) == "vv")
	})
}

var pageRe = regexp2.MustCompile(`\(?\bpp?\.\s*(\d+)(?:\s*[-–—]\s*(\d+))?\)?`,
	regexp2.IgnoreCase|regexp2.ECMAScript)

func ExpandPages(text string, conn biblebooks.Connectives) string {
	return replaceAll(pageRe, text, func(m regexp2.Match) string {
		p1, p2 := group(m, 1), group(m, 2)
		if p2 != "" {
			return conn.Pages + " " + sayNum(conn, p1) + " " + conn.Through + " " + sayNum(conn, p2)
		}
		return conn.Page + " " + sayNum(conn, p1)
	})
}

// "ch. 38" -> "chapter 38", "chs. 6-9" -> "chapters 6 through 9".
var chapterRe = regexp2.MustCompile(
	`\bch(s|ap|aps)?\.\s*(\d+)(?:\s*[-–—]\s*(\d+))?((?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)+)?`,
	regexp2.IgnoreCase|regexp2.ECMAScript)

func ExpandChapters(text string, conn biblebooks.Connectives) string {
	return replaceAll(chapterRe, text, func(m regexp2.Match) string {
		plural := strings.HasSuffix(strings.ToLower(group(m, 1)), "s")
		return speakNumbers(conn, conn.Chapter, conn.Chapters, group(m, 2), group(m, 3), group(m, 4), plural)
	})
}

// A parenthesized bare number range — "(42 – 45)" — is a chapter/section
// reference in commentary prose; read the dash rather than voicing it.
var parenRangeRe = regexp.MustCompile(`\((\d+)\s*[-–—]\s*(\d+)\)`)

func ExpandParenRanges(text string, conn biblebooks.Connectives) string {
	return parenRangeRe.ReplaceAllStringFunc(text, func(match string) string {
		m := parenRangeRe.FindStringSubmatch(match)
		return "(" + sayNum(conn, m[1]) + " " + rangeJoin(conn, m[1], m[2]) + " " + sayNum(conn, m[2]) + ")"
	})
}

// "1 and 2 Samuel" -> "first and second Samuel". Only rewritten when both
// ordinals form a known book.
func pairedBooksRe(conn biblebooks.Connectives) *regexp2.Regexp {
	return cached(&pairedCache, conn.Lang, func() *regexp2.Regexp {
		return regexp2.MustCompile(
			`(?<![\p{L}\d])([123]|i{1,3})\s+`+regexp.QuoteMeta(conn.And)+`\s+([123]|i{1,3})\s+(\p{L}[\p{L}.]*)`,
			regexp2.IgnoreCase)
	})
}

func ExpandPairedBooks(text string, books map[string]string, conn biblebooks.Connectives) string {
	return replaceAll(pairedBooksRe(conn), text, func(m regexp2.Match) string {
		n1, n2, bookWord := group(m, 1), group(m, 2), group(m, 3)
		a1, a2 := n1, n2
		if r, ok := roman[strings.ToLower(n1)]; ok {
			a1 = r
		}
		if r, ok := roman[strings.ToLower(n2)]; ok {
			a2 = r
		}
		hit1 := matchBook(books, a1, []string{bookWord})
		hit2 := matchBook(books, a2, []string{bookWord})
		if hit1 == nil || hit2 == nil {
			return m.String()
		}
		return strings.Split(hit1.say, " ")[0] + " " + conn.And + " " + hit2.say
	})
}

// A book reference with a chapter (or range/list) and no verse — "Gen 24",
// "Luke 1 – 2". No "chapter" label is inserted, matching how these are spoken.
var bookRefRe = regexp2.MustCompile(
	`(?<![\p{L}\d])(?:([123]|i{1,3})(?![\p{L}])\s*)?((?:\p{L}[\p{L}.]*)(?:\s+\p{L}[\p{L}.]*){0,2})\s+(\d+)(?:\s*[-–—]\s*(\d+))?((?:\s*,\s*\d+(?:\s*[-–—]\s*\d+)?)+)?(?![:\d])`,
	regexp2.IgnoreCase)

func startsUpper(s string) bool {
	for _, r := range s {
		return unicode.IsUpper(r)
	}
	return false
}

func ExpandBookRefs(text string, books map[string]string, conn biblebooks.Connectives) string {
	return replaceAll(bookRefRe, text, func(m regexp2.Match) string {
		num, wordsRaw := group(m, 1), group(m, 2)
		c1, c2, rest := group(m, 3), group(m, 4), group(m, 5)
		numArabic := ""
		if num != "" {
			numArabic = num
			if r, ok := roman[strings.ToLower(num)]; ok {
				numArabic = r
			}
		}
		words := strings.Fields(strings.TrimSpace(wordsRaw))
		hit := matchBook(books, numArabic, words)
		if hit == nil {
			return m.String()
		}
		// Without a verse a lone "Book N" is weakly signalled, so require the
		// book word to be capitalized — references are; prose nouns aren't.
		if !startsUpper(words[len(words)-hit.take]) {
			return m.String()
		}
		pre := ""
		if preamble := words[:len(words)-hit.take]; len(preamble) > 0 {
			pre = strings.Join(preamble, " ") + " "
		}
		return pre + hit.say + " " + joinList(conn, spokenParts(conn, c1, c2, rest))
	})
}

// A numbered book named on its own, with no chapter/verse following —
// "2 Samuel" in prose: the digit is part of the name and must read as the
// book's ordinal.
var bareBookRe = regexp2.MustCompile(
	`(?<![\p{L}\d])([123]|i{1,3})(?![\p{L}])\s+((?:\p{L}[\p{L}.]*)(?:\s+\p{L}[\p{L}.]*){0,1})(?![\p{L}])(?!\s*\d)`,
	regexp2.IgnoreCase)

func ExpandBareBooks(text string, books map[string]string, conn biblebooks.Connectives) string {
	return replaceAll(bareBookRe, text, func(m regexp2.Match) string {
		num, wordsRaw := group(m, 1), group(m, 2)
		numArabic := num
		if r, ok := roman[strings.ToLower(num)]; ok {
			numArabic = r
		}
		words := strings.Fields(strings.TrimSpace(wordsRaw))
		if !startsUpper(words[len(words)-1]) {
			return m.String()
		}
		hit := matchBook(books, numArabic, words)
		if hit == nil {
			return m.String()
		}
		pre := ""
		if preamble := words[:len(words)-hit.take]; len(preamble) > 0 {
			pre = strings.Join(preamble, " ") + " "
		}
		return pre + hit.say
	})
}

// ExpandLabeledRanges voices only the dash of a range following an
// already-spelled-out label — "chapters 42 – 45".
func ExpandLabeledRanges(text string, conn biblebooks.Connectives) string {
	re := cached(&labeledCache, conn.Lang, func() *regexp2.Regexp {
		labels := []string{conn.Chapters, conn.Chapter, conn.Verses, conn.Verse}
		sort.Slice(labels, func(i, j int) bool { return len(labels[i]) > len(labels[j]) })
		for i := range labels {
			labels[i] = regexp.QuoteMeta(labels[i])
		}
		return regexp2.MustCompile(
			`\b(`+strings.Join(labels, "|")+`)\s+(\d+)\s*[-–—]\s*(\d+)`,
			regexp2.IgnoreCase)
	})
	return replaceAll(re, text, func(m regexp2.Match) string {
		label, a, b := group(m, 1), group(m, 2), group(m, 3)
		return label + " " + sayNum(conn, a) + " " + rangeJoin(conn, a, b) + " " + sayNum(conn, b)
	})
}

// A standalone number, possibly with grouping/decimal separators. Bounded by
// non-alphanumerics so "1st", "h2o" or "v1.5" fragments aren't touched.
var numberRe = regexp2.MustCompile(`(?<![\p{L}\d.,])\d+(?:[.,]\d+)*(?![\p{L}\d])`, 0)

var decimalTailRe = regexp.MustCompile(`[.,](\d{1,2})$`)

// spellNumber spells out one number token. A 1-2 digit trailing group after
// the last separator reads as a decimal ("3.14" -> "three point one four");
// anything else is digit grouping and dropped ("1,000" -> "one thousand").
func spellNumber(token string, conn biblebooks.Connectives) string {
	dec := decimalTailRe.FindStringSubmatch(token)
	intRaw := token
	if dec != nil {
		intRaw = token[:len(token)-len(dec[0])]
	}
	intDigits := strings.NewReplacer(".", "", ",", "").Replace(intRaw)
	if intDigits == "" {
		return token
	}
	n, err := strconv.ParseInt(intDigits, 10, 64)
	if err != nil || n > 999_999_999 {
		return token
	}
	out := numberwords.NumberToWords(n, conn.Lang)
	if dec != nil {
		var frac []string
		for _, d := range dec[1] {
			frac = append(frac, numberwords.NumberToWords(int64(d-'0'), conn.Lang))
		}
		out += " " + conn.Point + " " + strings.Join(frac, " ")
	}
	return out
}

// ExpandNumbers spells out every remaining bare number so the TTS never has
// to guess.
func ExpandNumbers(text string, conn biblebooks.Connectives) string {
	return replaceAll(numberRe, text, func(m regexp2.Match) string {
		return spellNumber(m.String(), conn)
	})
}

var doubleSpaces = regexp.MustCompile(` {2,}`)

func isWordTerm(t string) bool {
	runes := []rune(t)
	first, last := runes[0], runes[len(runes)-1]
	isAlnum := func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }
	return isAlnum(first) || isAlnum(last)
}

// ExpandAcronyms does whole-word, case-sensitive acronym expansion (uppercase
// NVI matches; lowercase words don't). Longest terms first so "NKJV" beats
// "KJV". Symbol terms ("=") carry no alphanumerics and match even glued to
// text ("x=5"), with their spoken form padded by spaces.
func ExpandAcronyms(text string, acronyms []model.Acronym) string {
	if len(acronyms) == 0 {
		return text
	}
	sorted := append([]model.Acronym(nil), acronyms...)
	sort.SliceStable(sorted, func(i, j int) bool { return len(sorted[i].Term) > len(sorted[j].Term) })
	say := map[string]string{}
	var words, symbols []string
	for _, a := range sorted {
		if _, dup := say[a.Term]; !dup {
			say[a.Term] = a.Say
		}
		if isWordTerm(a.Term) {
			words = append(words, regexp.QuoteMeta(a.Term))
		} else {
			symbols = append(symbols, regexp.QuoteMeta(a.Term))
		}
	}
	var parts []string
	if len(words) > 0 {
		parts = append(parts, `(?<![\p{L}\d])(?:`+strings.Join(words, "|")+`)(?![\p{L}\d])`)
	}
	if len(symbols) > 0 {
		parts = append(parts, `(?:`+strings.Join(symbols, "|")+`)`)
	}
	pattern := strings.Join(parts, "|")
	re := cached(&acronymCache, pattern, func() *regexp2.Regexp {
		return regexp2.MustCompile(pattern, 0)
	})
	out := replaceAll(re, text, func(m regexp2.Match) string {
		term := m.String()
		spoken, ok := say[term]
		if !ok {
			spoken = term
		}
		if isWordTerm(term) {
			return spoken
		}
		return " " + spoken + " "
	})
	return strings.TrimSpace(doubleSpaces.ReplaceAllString(out, " "))
}

// AcronymsFor supplies the per-language acronym list; main wires this to the
// DB-backed cache. Defaults to the built-in seed set so pure-function tests
// need no database.
var AcronymsFor = func(ctx context.Context, language string) []model.Acronym {
	return model.DefaultAcronyms[language]
}

// NormalizeForSpeech rewrites text into a more speakable form for TTS,
// falling back to English tables for unknown languages.
func NormalizeForSpeech(ctx context.Context, text, language string) string {
	if text == "" {
		return text
	}
	lang := biblebooks.ResolveLang(language)
	books := biblebooks.BibleBooks[lang]
	conn := biblebooks.CONNECTIVES[lang]
	// Consume explicit abbreviations (pp./vv./ch.) before the generic
	// book-range matcher, so "pp. 119-176" reads as pages, not the "pp"
	// Philippians alias.
	out := ExpandReferences(text, books, conn)
	out = ExpandVerseRefs(out, conn)
	out = ExpandPages(out, conn)
	out = ExpandChapters(out, conn)
	out = ExpandPairedBooks(out, books, conn)
	out = ExpandBookRefs(out, books, conn)
	out = ExpandBareBooks(out, books, conn)
	out = ExpandBareReferences(out, conn)
	out = ExpandLabeledRanges(out, conn)
	out = ExpandParenRanges(out, conn)
	out = ExpandAcronyms(out, AcronymsFor(ctx, lang))
	// Last: any number the reference passes didn't touch is plain prose —
	// spell it out too so nothing is left as digits.
	out = ExpandNumbers(out, conn)
	return out
}
