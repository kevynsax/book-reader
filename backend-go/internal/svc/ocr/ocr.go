// Package ocr talks to the QwenVL vision servers (page OCR, title, TOC,
// language detection) and the SLM servers (line split, grammar review), and
// locates TOC chapter titles in the OCR'd text.
package ocr

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"

	"github.com/kevynsax/book-reader/backend-go/internal/config"
	"github.com/kevynsax/book-reader/backend-go/internal/lib/sanitize"
)

type Result struct {
	Language string
	Content  string
}

type ChapterSuggestion struct {
	Title     string `json:"title"`
	Page      int    `json:"page"`
	StartChar int    `json:"startChar"`
	Found     bool   `json:"found"`
}

type SplitLineSuggestion struct {
	Left  string `json:"left"`
	Right string `json:"right"`
}

// TocEntry is one table-of-contents row a VLM extracted from a summary page.
type TocEntry struct {
	Title string
	Page  int
}

var (
	fenceOpen  = regexp.MustCompile("(?i)^```(?:json)?\\s*")
	fenceClose = regexp.MustCompile("(?i)\\s*```$")
	looseJSON  = regexp.MustCompile(`(?s)\{.*\}|\[.*\]`)
)

func stripMarkdownFence(text string) string {
	return strings.TrimSpace(fenceClose.ReplaceAllString(fenceOpen.ReplaceAllString(text, ""), ""))
}

// parseJSONLoose parses text as JSON, falling back to the outermost {...} or
// [...] block (models sometimes wrap JSON in prose).
func parseJSONLoose(text string) any {
	var v any
	if err := json.Unmarshal([]byte(text), &v); err == nil {
		return v
	}
	if m := looseJSON.FindString(text); m != "" {
		if err := json.Unmarshal([]byte(m), &v); err == nil {
			return v
		}
	}
	return nil
}

func parseOcrResult(raw string) Result {
	text := stripMarkdownFence(strings.TrimSpace(raw))
	if parsed, ok := parseJSONLoose(text).(map[string]any); ok {
		res := Result{Language: "unknown"}
		if l, ok := parsed["language"].(string); ok {
			res.Language = strings.ToLower(l)
		}
		if c, ok := parsed["content"].(string); ok {
			res.Content = strings.TrimSpace(c)
		}
		return res
	}
	return Result{Language: "unknown", Content: sanitize.PageText(text)}
}

func parseTocEntries(raw string) []TocEntry {
	text := stripMarkdownFence(strings.TrimSpace(raw))
	arr, ok := parseJSONLoose(text).([]any)
	if !ok {
		return nil
	}
	var out []TocEntry
	for _, item := range arr {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		title, tok := obj["title"].(string)
		page, pok := obj["page"].(float64)
		if !tok || !pok {
			continue
		}
		title = strings.TrimSpace(title)
		if title != "" {
			out = append(out, TocEntry{Title: title, Page: int(page)})
		}
	}
	return out
}

func parseSplitLineSuggestion(raw string) *SplitLineSuggestion {
	obj, ok := parseJSONLoose(stripMarkdownFence(strings.TrimSpace(raw))).(map[string]any)
	if !ok {
		return nil
	}
	left, lok := obj["left"].(string)
	right, rok := obj["right"].(string)
	if !lok || !rok {
		return nil
	}
	cleanLeft := strings.TrimSpace(sanitize.PageText(left))
	cleanRight := strings.TrimSpace(sanitize.PageText(right))
	if cleanLeft == "" || cleanRight == "" {
		return nil
	}
	return &SplitLineSuggestion{Left: cleanLeft, Right: cleanRight}
}

// parseSplitParts parses the SLM's multi-way split: a JSON array of sentence
// strings, or an object wrapping one under parts/sentences.
func parseSplitParts(raw string) []string {
	parsed := parseJSONLoose(stripMarkdownFence(strings.TrimSpace(raw)))
	arr, ok := parsed.([]any)
	if !ok {
		if obj, isObj := parsed.(map[string]any); isObj {
			if a, isArr := obj["parts"].([]any); isArr {
				arr = a
			} else if a, isArr := obj["sentences"].([]any); isArr {
				arr = a
			} else {
				return nil
			}
		} else {
			return nil
		}
	}
	var parts []string
	for _, item := range arr {
		if s, ok := item.(string); ok {
			if clean := strings.TrimSpace(sanitize.PageText(s)); clean != "" {
				parts = append(parts, clean)
			}
		}
	}
	return parts
}

func parseCorrected(raw string) string {
	obj, ok := parseJSONLoose(stripMarkdownFence(strings.TrimSpace(raw))).(map[string]any)
	if !ok {
		return ""
	}
	corrected, ok := obj["corrected"].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(sanitize.PageText(corrected))
}

type chatMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

func postChat(ctx context.Context, baseURL string, body any) (string, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(baseURL, "/")+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		host := baseURL
		if u, err := url.Parse(baseURL); err == nil {
			host = u.Host
		}
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		detail := strings.TrimSpace(string(raw))
		if detail != "" && !strings.HasPrefix(detail, "<") {
			if len(detail) > 200 {
				detail = detail[:200]
			}
			return "", fmt.Errorf("QwenVL %s returned %d %s: %s", host, res.StatusCode, http.StatusText(res.StatusCode), detail)
		}
		return "", fmt.Errorf("QwenVL %s returned %d %s", host, res.StatusCode, http.StatusText(res.StatusCode))
	}

	var data struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return "", err
	}
	if len(data.Choices) == 0 {
		return "", nil
	}
	return strings.TrimSpace(data.Choices[0].Message.Content), nil
}

func imageContentBytes(prompt string, data []byte) []any {
	dataURL := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data)
	return []any{
		map[string]any{"type": "text", "text": prompt},
		map[string]any{"type": "image_url", "image_url": map[string]string{"url": dataURL}},
	}
}

func callQwen(ctx context.Context, systemPrompt string, userContent []any, baseURL, model string) (string, error) {
	return postChat(ctx, baseURL, map[string]any{
		"model":       model,
		"temperature": 0,
		"max_tokens":  config.QwenVlMaxTokens,
		"messages": []chatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userContent},
		},
	})
}

// Single-server, bytes-based variants used by the role workers: each worker
// owns exactly one AI server, so there is no fallback here — a failed task is
// the broker's to redeliver.

func OcrPageData(ctx context.Context, image []byte, baseURL, model string) (Result, error) {
	raw, err := callQwen(ctx, config.OcrSystemPrompt, imageContentBytes(config.OcrPagePrompt, image), baseURL, model)
	if err != nil {
		return Result{}, err
	}
	return parseOcrResult(raw), nil
}

func ExtractTitleData(ctx context.Context, image []byte, baseURL, model string) (string, error) {
	raw, err := callQwen(ctx, config.TitleSystemPrompt, imageContentBytes(config.TitlePagePrompt, image), baseURL, model)
	if err != nil {
		return "", err
	}
	if obj, ok := parseJSONLoose(stripMarkdownFence(strings.TrimSpace(raw))).(map[string]any); ok {
		if title, ok := obj["title"].(string); ok {
			return strings.TrimSpace(title), nil
		}
	}
	return "", nil
}

func DetectLanguageData(ctx context.Context, image []byte, baseURL, model string) (string, error) {
	raw, err := callQwen(ctx, config.LangSystemPrompt, imageContentBytes(config.LangPagePrompt, image), baseURL, model)
	if err != nil {
		return "", err
	}
	if obj, ok := parseJSONLoose(stripMarkdownFence(strings.TrimSpace(raw))).(map[string]any); ok {
		if lang, ok := obj["language"].(string); ok {
			return strings.TrimSpace(strings.ToLower(lang)), nil
		}
	}
	return "unknown", nil
}

func ExtractTocData(ctx context.Context, image []byte, baseURL, model string) ([]TocEntry, error) {
	raw, err := callQwen(ctx, config.TocSystemPrompt, imageContentBytes(config.TocPagePrompt, image), baseURL, model)
	if err != nil {
		return nil, err
	}
	return parseTocEntries(raw), nil
}

// SLM dispatch: 'balance' routes each call to the server with the least
// in-flight work relative to its weight (bulk work); 'race' hits every server
// at once and takes the first success (single-request latency).
const slmRaceTimeout = 10 * time.Second

var (
	slmMu       sync.Mutex
	slmInFlight = map[string]int{}
)

func balancedServers() []config.SlmServer {
	slmMu.Lock()
	defer slmMu.Unlock()
	servers := append([]config.SlmServer(nil), config.SlmServers...)
	sort.SliceStable(servers, func(i, j int) bool {
		return float64(slmInFlight[servers[i].URL])/float64(servers[i].Weight) <
			float64(slmInFlight[servers[j].URL])/float64(servers[j].Weight)
	})
	return servers
}

func slmPost(ctx context.Context, base, path string, body []byte, timeout time.Duration) ([]byte, error) {
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	method := http.MethodGet
	var reader io.Reader
	if body != nil {
		method = http.MethodPost
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		msg := strings.TrimSpace(string(raw))
		if msg == "" {
			msg = fmt.Sprintf("SLM API returned %d", res.StatusCode)
		}
		return nil, fmt.Errorf("%s", msg)
	}
	return raw, nil
}

func balanceFetch(ctx context.Context, path string, body []byte, timeout time.Duration) ([]byte, error) {
	servers := balancedServers()
	if len(servers) == 0 {
		return nil, fmt.Errorf("no SLM servers configured (set SLM_API)")
	}
	var lastErr error
	for _, s := range servers {
		slmMu.Lock()
		slmInFlight[s.URL]++
		slmMu.Unlock()
		out, err := slmPost(ctx, s.URL, path, body, timeout)
		slmMu.Lock()
		if slmInFlight[s.URL] > 0 {
			slmInFlight[s.URL]--
		}
		slmMu.Unlock()
		if err == nil {
			return out, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func raceFetch(ctx context.Context, path string, body []byte, timeout time.Duration) ([]byte, error) {
	servers := config.SlmServers
	if len(servers) == 0 {
		return nil, fmt.Errorf("no SLM servers configured (set SLM_API)")
	}
	if timeout <= 0 {
		timeout = slmRaceTimeout
	}
	raceCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	type attempt struct {
		out []byte
		err error
	}
	results := make(chan attempt, len(servers))
	for _, s := range servers {
		go func(base string) {
			out, err := slmPost(raceCtx, base, path, body, 0)
			results <- attempt{out, err}
		}(s.URL)
	}
	var lastErr error
	for range servers {
		a := <-results
		if a.err == nil {
			return a.out, nil // remaining attempts die with raceCtx
		}
		lastErr = a.err
	}
	return nil, lastErr
}

func FetchSlmModels(ctx context.Context) ([]map[string]string, error) {
	raw, err := raceFetch(ctx, "/v1/models", nil, 5*time.Second)
	if err != nil {
		return nil, err
	}
	var data struct {
		Data []map[string]any `json:"data"`
	}
	_ = json.Unmarshal(raw, &data)
	var models []map[string]string
	for _, item := range data.Data {
		id, _ := item["id"].(string)
		if id == "" {
			id, _ = item["model"].(string)
		}
		if id != "" {
			models = append(models, map[string]string{"id": id, "label": id})
		}
	}
	if len(models) == 0 {
		models = []map[string]string{{"id": config.SlmModel, "label": config.SlmModel}}
	}
	return models, nil
}

func slmChatBody(systemPrompt, userText, model string) ([]byte, error) {
	if model == "" {
		model = config.SlmModel
	}
	return json.Marshal(map[string]any{
		"model":       model,
		"temperature": 0,
		"max_tokens":  512,
		"messages": []chatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userText},
		},
	})
}

func parseSlmChat(raw []byte) (string, error) {
	var data struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", err
	}
	if len(data.Choices) == 0 {
		return "", nil
	}
	return strings.TrimSpace(data.Choices[0].Message.Content), nil
}

func callSlm(ctx context.Context, systemPrompt, userText, model string, race bool) (string, error) {
	body, err := slmChatBody(systemPrompt, userText, model)
	if err != nil {
		return "", err
	}
	var raw []byte
	if race {
		raw, err = raceFetch(ctx, "/v1/chat/completions", body, 0)
	} else {
		raw, err = balanceFetch(ctx, "/v1/chat/completions", body, 0)
	}
	if err != nil {
		return "", err
	}
	return parseSlmChat(raw)
}

// callSlmOn hits exactly one SLM server — the worker path.
func callSlmOn(ctx context.Context, base, systemPrompt, userText, model string) (string, error) {
	body, err := slmChatBody(systemPrompt, userText, model)
	if err != nil {
		return "", err
	}
	raw, err := slmPost(ctx, base, "/v1/chat/completions", body, 0)
	if err != nil {
		return "", err
	}
	return parseSlmChat(raw)
}

var splitInTwoPrompt = strings.Join([]string{
	"You split a single long book sentence into two complete, natural, valid sentences for text-to-speech review.",
	"Return one valid JSON object and nothing else.",
	`The JSON object must have this exact shape: {"left":"...","right":"..."}`,
	"Preserve the original language, meaning, named entities, and reading order.",
	"Keep left and right close to the same character length whenever possible.",
	"Prefer a split point near the middle of the original line, but never at the cost of producing unnatural or invalid sentences.",
	"You may add or adjust only minimal punctuation and capitalization needed to make both outputs complete sentences.",
	"Do not summarize, translate, expand, omit meaning, add commentary, or use markdown.",
	`If the line cannot be split into two valid sentences, return {"left":"","right":""}.`,
}, " ")

func splitToMaxPrompt(maxChars int) string {
	return strings.Join([]string{
		"You split a single long book sentence into several complete, natural, valid sentences for text-to-speech.",
		fmt.Sprintf("Each output sentence must be at most %d characters long.", maxChars),
		`Return one valid JSON array of strings and nothing else, e.g. ["First sentence.", "Second sentence."].`,
		"Preserve the original language, meaning, named entities, and reading order exactly.",
		"Split only at natural sentence or clause boundaries; never split inside a word, number, or reference.",
		"Use as many pieces as needed so every piece is within the limit, but no more pieces than necessary.",
		"You may add or adjust only the minimal punctuation and capitalization needed to make each output a complete sentence.",
		"Do not summarize, translate, expand, omit meaning, add commentary, or use markdown.",
		"If the sentence cannot be split, return an array containing only the original sentence.",
	}, " ")
}

func SplitLineIntoSentences(ctx context.Context, line, model string) (*SplitLineSuggestion, error) {
	raw, err := callSlm(ctx, splitInTwoPrompt, line, model, false)
	if err != nil {
		return nil, err
	}
	return parseSplitLineSuggestion(raw), nil
}

// SplitLineIntoSentencesOn is the single-server worker variant.
func SplitLineIntoSentencesOn(ctx context.Context, base, line, model string) (*SplitLineSuggestion, error) {
	raw, err := callSlmOn(ctx, base, splitInTwoPrompt, line, model)
	if err != nil {
		return nil, err
	}
	return parseSplitLineSuggestion(raw), nil
}

// SplitLineIntoParts asks the SLM to break one long sentence into as many
// complete, natural sentences as needed so each is at most maxChars — more
// than two is fine. Returns nil when the model declines or yields one piece.
func SplitLineIntoParts(ctx context.Context, line string, maxChars int, model string) ([]string, error) {
	raw, err := callSlm(ctx, splitToMaxPrompt(maxChars), line, model, false)
	if err != nil {
		return nil, err
	}
	parts := parseSplitParts(raw)
	if len(parts) > 1 {
		return parts, nil
	}
	return nil, nil
}

// SplitLineIntoPartsOn is the single-server worker variant.
func SplitLineIntoPartsOn(ctx context.Context, base, line string, maxChars int, model string) ([]string, error) {
	raw, err := callSlmOn(ctx, base, splitToMaxPrompt(maxChars), line, model)
	if err != nil {
		return nil, err
	}
	parts := parseSplitParts(raw)
	if len(parts) > 1 {
		return parts, nil
	}
	return nil, nil
}

func ReviewLineGrammar(ctx context.Context, line, model string) (string, error) {
	raw, err := callSlm(ctx, strings.Join([]string{
		"You proofread a single line from an OCR-extracted book for grammar mistakes and typos.",
		"Return one valid JSON object and nothing else.",
		`The JSON object must have this exact shape: {"corrected":"..."}`,
		"Fix only clear spelling, OCR, and grammar errors.",
		"Preserve the original language, meaning, named entities, punctuation style, and reading order.",
		"Do not rephrase, restyle, translate, summarize, expand, split, merge, or change text that is already correct.",
		"Do not add commentary or markdown.",
		`If the line has no errors, return it unchanged in the "corrected" field.`,
	}, " "), line, model, false)
	if err != nil {
		return "", err
	}
	return parseCorrected(raw), nil
}

// fold applies NFKD and strips the same combining-mark block Node strips
// (U+0300–U+036F), then lowercases.
func fold(s string) string {
	decomposed := norm.NFKD.String(s)
	var b strings.Builder
	b.Grow(len(decomposed))
	for _, r := range decomposed {
		if r >= 0x0300 && r <= 0x036F {
			continue
		}
		b.WriteRune(r)
	}
	return strings.ToLower(b.String())
}

var titleSepClass = regexp.MustCompile(`[\s.·•–—:_-]+`)

func titleNeedles(title string) []string {
	var needles []string
	add := func(s string) {
		v := strings.TrimSpace(s)
		if len([]rune(v)) >= 2 {
			for _, n := range needles {
				if n == v {
					return
				}
			}
			needles = append(needles, v)
		}
	}
	full := strings.TrimSpace(title)
	noTail := strings.TrimSpace(trailingDots.ReplaceAllString(trailingPageNum.ReplaceAllString(full, ""), ""))
	noHead := strings.TrimSpace(leadingChapterNum.ReplaceAllString(noTail, ""))
	add(noTail)
	add(noHead)
	add(full)
	return needles
}

var (
	trailingPageNum   = regexp.MustCompile(`[\s.·•–—-]*\d+\s*$`)
	trailingDots      = regexp.MustCompile(`[\s.·•]+$`)
	leadingChapterNum = regexp.MustCompile(`(?i)^\s*(chapter|cap[ií]tulo|part[e]?|secti?on|se[cç][aã]o)?\s*[\dIVXLCDM]+\s*[:.)\-—–]?\s*`)
)

// Words of a chapter title are often broken across lines on the chapter's own
// title page, so match the words in order allowing any whitespace/punctuation
// run between them.
const titleSep = `[\s.·•–—:_-]+`

func titleRegex(needle string) *regexp.Regexp {
	parts := titleSepClass.Split(needle, -1)
	var escaped []string
	for _, p := range parts {
		if p != "" {
			escaped = append(escaped, regexp.QuoteMeta(p))
		}
	}
	if len(escaped) == 0 {
		return nil
	}
	re, err := regexp.Compile("(?i)" + strings.Join(escaped, titleSep))
	if err != nil {
		return nil
	}
	return re
}

// utf16Index converts a byte offset in s to a UTF-16 code-unit offset — JS
// string indexes (what startChar has always stored) count UTF-16 units.
func utf16Index(s string, byteIdx int) int {
	return len(utf16.Encode([]rune(s[:byteIdx])))
}

func findTitleOffset(title, text string) int {
	foldText := fold(text)
	for _, needle := range titleNeedles(title) {
		if re := titleRegex(needle); re != nil {
			if loc := re.FindStringIndex(text); loc != nil {
				return utf16Index(text, loc[0])
			}
		}
		if re := titleRegex(fold(needle)); re != nil {
			// Accent-insensitive fallback. NFKD keeps positions for
			// single-accent Latin characters, so the index into the folded
			// text maps back to the original.
			if loc := re.FindStringIndex(foldText); loc != nil {
				return utf16Index(foldText, loc[0])
			}
		}
	}
	return -1
}

func resolveLocation(entry TocEntry, byPage map[int]string, orderedPages []int) ChapterSuggestion {
	half := entry.Page / 2
	if entry.Page-half*2 != 0 { // Math.round(x/2) for odd pages rounds up
		half++
	}
	if half < 1 {
		half = 1
	}
	seen := map[int]bool{}
	var order []int
	for _, p := range append([]int{entry.Page, half}, orderedPages...) {
		if !seen[p] {
			seen[p] = true
			order = append(order, p)
		}
	}
	for _, page := range order {
		text, ok := byPage[page]
		if !ok {
			continue
		}
		if offset := findTitleOffset(entry.Title, text); offset >= 0 {
			return ChapterSuggestion{Title: entry.Title, Page: page, StartChar: offset, Found: true}
		}
	}
	return ChapterSuggestion{Title: entry.Title, Page: entry.Page, StartChar: 0, Found: false}
}

type PageText struct {
	Page int
	Text string
}

// ResolveChapters merges the per-summary-page TOC lists (dropping duplicate
// title+page entries from overlapping pages) and locates each title in the
// OCR'd text. Pure text work — the TOC extraction itself happens on the vlm
// workers.
func ResolveChapters(tocLists [][]TocEntry, ocrPages []PageText) []ChapterSuggestion {
	seen := map[string]bool{}
	var toc []TocEntry
	for _, list := range tocLists {
		for _, entry := range list {
			key := strings.ToLower(entry.Title) + "|" + fmt.Sprint(entry.Page)
			if !seen[key] {
				seen[key] = true
				toc = append(toc, entry)
			}
		}
	}
	if len(toc) == 0 {
		return []ChapterSuggestion{}
	}

	byPage := map[int]string{}
	orderedPages := make([]int, len(ocrPages))
	for i, p := range ocrPages {
		byPage[p.Page] = p.Text
		orderedPages[i] = p.Page
	}
	out := make([]ChapterSuggestion, len(toc))
	for i, entry := range toc {
		out[i] = resolveLocation(entry, byPage, orderedPages)
	}
	return out
}
