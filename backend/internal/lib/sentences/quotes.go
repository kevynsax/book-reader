package sentences

import "strings"

// QuoteRun is one narration or quotation span of a sentence.
type QuoteRun struct {
	Text    string
	IsQuote bool
}

// A quoted span shorter than this many words stays glued to its narration —
// a two-word term in scare quotes is not dialogue worth a voice switch.
const quoteMinWords = 4

var quotePairs = map[rune]rune{
	'"': '"',
	'“': '”',
	'«': '»',
}

// SplitQuoteRuns divides a sentence into narration and quotation runs so an
// audiobook can voice the quoted words separately. Quotation marks stay with
// the quote (plus its immediately trailing punctuation); pt-BR em-dash
// dialogue ("— Fala, papai.") counts as one quote run. An unclosed quote runs
// to the end of the text. Deterministic — a classifier only decides WHO
// speaks a quote, never invents one.
func SplitQuoteRuns(text string) []QuoteRun {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}

	// Em-dash dialogue: the dash opens direct speech that runs to the end.
	if r := []rune(trimmed); r[0] == '—' || r[0] == '–' {
		return []QuoteRun{{Text: trimmed, IsQuote: true}}
	}

	runes := []rune(trimmed)
	var runs []QuoteRun
	flush := func(start, end int, quote bool) {
		t := strings.TrimSpace(string(runes[start:end]))
		if t == "" {
			return
		}
		runs = append(runs, QuoteRun{Text: t, IsQuote: quote})
	}

	segStart := 0
	for i := 0; i < len(runes); i++ {
		closer, ok := quotePairs[runes[i]]
		if !ok {
			continue
		}
		end := -1
		for j := i + 1; j < len(runes); j++ {
			if runes[j] == closer {
				end = j
				break
			}
		}
		if end < 0 {
			end = len(runes) - 1
		}
		// Trailing punctuation right after the closing mark belongs to the
		// quote ("…camelo", disse.  → the comma stays with the narration,
		// but a sentence-ender does not restart narration).
		stop := end + 1
		for stop < len(runes) && (runes[stop] == '.' || runes[stop] == '!' || runes[stop] == '?') {
			stop++
		}
		if len(strings.Fields(string(runes[i:end+1]))) < quoteMinWords {
			i = end
			continue
		}
		flush(segStart, i, false)
		flush(i, stop, true)
		segStart = stop
		i = stop - 1
	}
	flush(segStart, len(runes), false)

	if len(runs) == 0 {
		return []QuoteRun{{Text: trimmed, IsQuote: false}}
	}
	return runs
}
