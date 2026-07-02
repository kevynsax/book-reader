package sanitize

import (
	"encoding/json"
	"regexp"
	"strings"
)

var (
	leadingFence  = regexp.MustCompile(`(?i)^` + "```" + `(?:json)?\s*`)
	trailingFence = regexp.MustCompile(`(?i)\s*` + "```" + `$`)
	afterColon    = regexp.MustCompile(`^\s*:\s*"`)
	trailingQuote = regexp.MustCompile(`"\s*}?\s*$`)
)

// PageText strips markdown fences and unwraps a JSON {"content": ...} envelope
// an OCR model sometimes returns instead of plain text (port of sanitizePageText).
func PageText(text string) string {
	s := strings.TrimSpace(text)
	if s == "" {
		return ""
	}

	s = strings.TrimSpace(trailingFence.ReplaceAllString(leadingFence.ReplaceAllString(s, ""), ""))
	if s == "" || s[0] != '{' {
		return s
	}

	var parsed struct {
		Content *string `json:"content"`
	}
	if err := json.Unmarshal([]byte(s), &parsed); err == nil && parsed.Content != nil {
		return strings.TrimSpace(*parsed.Content)
	}

	if key := strings.Index(s, `"content"`); key >= 0 {
		after := s[key+len(`"content"`):]
		after = afterColon.ReplaceAllString(after, "")
		after = trailingQuote.ReplaceAllString(after, "")
		// Sequential (not single-pass) replacement to match Node's chained
		// .replace() semantics on pathological escape sequences.
		after = strings.ReplaceAll(after, `\"`, `"`)
		after = strings.ReplaceAll(after, `\n`, "\n")
		after = strings.ReplaceAll(after, `\r`, "\r")
		after = strings.ReplaceAll(after, `\t`, "\t")
		after = strings.ReplaceAll(after, `\\`, `\`)
		return strings.TrimSpace(after)
	}

	return s
}
