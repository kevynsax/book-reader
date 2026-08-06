package worker

import (
	"sort"
	"strings"
	"unicode"

	"github.com/kevynsax/book-reader/backend/internal/model"
)

func compactLetters(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// SentencePages maps each sentence of a chapter to the book page its text came
// from. Sentences carry no page of their own, so the chapter's per-page text is
// concatenated and each sentence is matched against it in order with a running
// cursor; the match offset falls inside exactly one page.
func SentencePages(book *model.Book, chapterIdx int) map[string]int {
	pages := ChapterPageTexts(book.Chapters, chapterIdx, book.OcrPages, book.LastPage)
	out := map[string]int{}
	if len(pages) == 0 {
		return out
	}

	var joined strings.Builder
	ends := make([]int, len(pages))
	for i, p := range pages {
		joined.WriteString(compactLetters(p.Text))
		ends[i] = joined.Len()
	}
	haystack := joined.String()
	pageAt := func(offset int) int {
		i := sort.SearchInts(ends, offset+1)
		if i >= len(pages) {
			i = len(pages) - 1
		}
		return pages[i].Page
	}

	ordered := append([]model.Sentence(nil), book.Chapters[chapterIdx].Sentences...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })

	cursor := 0
	current := pages[0].Page
	for _, sen := range ordered {
		text := sen.Text
		if sen.Display != nil && *sen.Display != "" {
			text = *sen.Display
		}
		needle := compactLetters(text)
		if needle != "" {
			if rel := strings.Index(haystack[cursor:], needle); rel >= 0 {
				current = pageAt(cursor + rel)
				cursor += rel + len(needle)
			}
		}
		out[sen.ID.Hex()] = current
	}
	return out
}
