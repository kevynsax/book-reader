// Package sentences reflows OCR page text so one line == one sentence,
// unwrapping mid-sentence hard breaks (phase 1). Generation (phase 2) then
// trusts those line breaks. Heuristic — over/under-splitting only affects
// highlight granularity, never audio correctness.
package sentences

import (
	"regexp"
	"strings"
	"unicode"
)

// A short bracketed aside is kept whole and glued to the sentence it follows.
const bracketKeepMax = 120

var openers = map[rune]rune{'(': ')', '[': ']', '{': '}'}

func isEnder(r rune) bool { return r == '.' || r == '!' || r == '?' || r == '…' }

func isCloser(r rune) bool {
	switch r {
	case '"', '\'', '”', '’', ')', ']', '}':
		return true
	}
	return false
}

// Reference abbreviations whose trailing period is not a sentence end.
var abbrevEnd = regexp.MustCompile(`(?i)(?:^|[\s(\[])(?:ch|chap|chaps|chs|v|vv|vs|p|pp|cf|vol|vols|esp|ff)\.$`)

var (
	blankLines = regexp.MustCompile(`\n{2,}`)
	whitespace = regexp.MustCompile(`\s+`)
)

// IsTitle reports whether text is a short standalone line — at most maxWords
// words. Used to pad silence around chapter/section headings during assembly.
func IsTitle(text string, maxWords int) bool {
	words := strings.Fields(strings.TrimSpace(text))
	return len(words) > 0 && len(words) <= maxWords
}

// nextNonSpaceIsDot reports whether the next non-space rune after i is a dot —
// used to detect ellipsis runs, including OCR's spaced form (". . .").
func nextNonSpaceIsDot(text []rune, i int) bool {
	j := i + 1
	for j < len(text) && unicode.IsSpace(text[j]) {
		j++
	}
	return j < len(text) && text[j] == '.'
}

type bracketGroup struct {
	full  string
	inner string
	end   int
}

// captureBracket returns the balanced group starting at `start`, its inner
// text, and the index past the closing bracket — or nil if unbalanced.
func captureBracket(text []rune, start int) *bracketGroup {
	var stack []rune
	for i := start; i < len(text); i++ {
		ch := text[i]
		if close, ok := openers[ch]; ok {
			stack = append(stack, close)
		} else if ch == ')' || ch == ']' || ch == '}' {
			if len(stack) == 0 || stack[len(stack)-1] != ch {
				return nil
			}
			stack = stack[:len(stack)-1]
			if len(stack) == 0 {
				return &bracketGroup{
					full:  string(text[start : i+1]),
					inner: string(text[start+1 : i]),
					end:   i + 1,
				}
			}
		}
	}
	return nil
}

// splitParagraph splits a whitespace-collapsed paragraph into sentences. Short
// bracketed groups are never split internally and, when they sit at a
// boundary, stay attached to the preceding sentence.
func splitParagraph(text []rune) []string {
	var out []string
	var buf strings.Builder
	i := 0

	push := func() {
		if s := strings.TrimSpace(buf.String()); s != "" {
			out = append(out, s)
		}
		buf.Reset()
	}

	for i < len(text) {
		ch := text[i]

		if _, ok := openers[ch]; ok {
			if grp := captureBracket(text, i); grp != nil && len([]rune(grp.inner)) < bracketKeepMax {
				buf.WriteString(grp.full)
				i = grp.end
				continue
			}
		}

		if ch == '…' || (ch == '.' && nextNonSpaceIsDot(text, i)) {
			// An ellipsis ("...", "…", or OCR's spaced ". . .") is not a
			// sentence boundary — keep the whole run inline.
			if ch == '…' {
				buf.WriteRune(ch)
				i++
			} else {
				buf.WriteRune(text[i])
				i++
				for i < len(text) && (text[i] == '.' || (unicode.IsSpace(text[i]) && nextNonSpaceIsDot(text, i))) {
					buf.WriteRune(text[i])
					i++
				}
			}
			continue
		}

		if ch == '.' && abbrevEnd.MatchString(buf.String()+".") {
			buf.WriteRune(ch)
			i++
			continue
		}

		if isEnder(ch) {
			buf.WriteRune(ch)
			i++
			for i < len(text) && isCloser(text[i]) {
				buf.WriteRune(text[i])
				i++
			}

			if i >= len(text) || unicode.IsSpace(text[i]) {
				k := i
				for k < len(text) && unicode.IsSpace(text[k]) {
					k++
				}
				// A short aside right after the boundary glues to this sentence.
				if k < len(text) {
					if _, ok := openers[text[k]]; ok {
						if grp := captureBracket(text, k); grp != nil && len([]rune(grp.inner)) < bracketKeepMax {
							buf.WriteString(" " + grp.full)
							push()
							i = grp.end
							continue
						}
					}
				}
				push()
				i = k
				continue
			}
			continue
		}

		buf.WriteRune(ch)
		i++
	}

	push()
	return out
}

// ReflowSentences reflows OCR'd page text into a sentence-per-line form:
// paragraphs (blank-line separated) are preserved, hard-wrapped lines inside a
// paragraph are unwrapped, and each sentence ends up on its own line.
func ReflowSentences(text string) string {
	var paras []string
	for _, para := range blankLines.Split(text, -1) {
		joined := strings.TrimSpace(whitespace.ReplaceAllString(para, " "))
		if joined == "" {
			continue
		}
		paras = append(paras, strings.Join(splitParagraph([]rune(joined)), "\n"))
	}
	return strings.Join(paras, "\n\n")
}
