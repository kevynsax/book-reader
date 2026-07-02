package config

import (
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

func Load() {
	_ = godotenv.Load()
	initAll()
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return v
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v, err := strconv.ParseFloat(os.Getenv(key), 64); err == nil {
		return v
	}
	return def
}

var (
	Port       int
	MongodbURI string

	SlmAPI            string
	SlmAPIFallback    string
	SlmModel          string
	SlmSplitModel     string
	SlmPrimaryWeight  int
	SlmFallbackWeight int
	SlmServers        []SlmServer

	// TtsServers remains on main only for the direct voice-sample and
	// voices-probing endpoints; all synthesis goes through the tts workers.
	TtsServers []TtsServer

	WhisperModel     string
	WhisperTimeoutMs int

	TtsVerify          bool
	TtsVerifyThreshold float64
	TtsVerifyMaxDepth  int
	// How many times a mismatching segment is re-synthesized before the SLM
	// is asked to split it.
	TtsVerifyAttempts int
	TtsVerifyMinChars  int

	TtsMaxSentenceChars int

	DataDir          string
	DeleteAllowedIPs []string
	DefaultVoice     string
	TtsSpeed         float64
	// Max segment pipelines in flight at once on the orchestrator; the actual
	// synthesis parallelism is however many healthy tts workers exist.
	TtsConcurrency int
	// Max OCR page tasks in flight at once (bounds page images queued in the
	// broker).
	OcrConcurrency   int
	TtsVolumeGain    float64
	TitleMaxWords    int
	TitleSilenceSecs float64
	TitleVolumeGain  float64
	DefaultLanguage  string
	FrontendOrigin   string
	// AmqpURL is the RabbitMQ endpoint of the role-worker task fabric.
	AmqpURL string
)

type SlmServer struct {
	URL    string
	Weight int
}

type TtsServer struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	URL   string `json:"url"`
}

var trailingSlashes = regexp.MustCompile(`/+$`)

func stripSlash(url string) string {
	return trailingSlashes.ReplaceAllString(url, "")
}

func splitEntries(raw string) []string {
	var out []string
	for _, part := range regexp.MustCompile(`[\n,]+`).Split(raw, -1) {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func parseTtsServers(raw string) []TtsServer {
	var out []TtsServer
	for _, entry := range splitEntries(raw) {
		parts := strings.Split(entry, "|")
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		s := TtsServer{ID: parts[0]}
		if len(parts) > 1 && parts[1] != "" {
			s.Label = parts[1]
		} else {
			s.Label = s.ID
		}
		if len(parts) > 2 {
			s.URL = stripSlash(parts[2])
		}
		if s.ID != "" && s.URL != "" {
			out = append(out, s)
		}
	}
	return out
}

func initAll() {
	Port = envInt("PORT", 3001)
	MongodbURI = env("MONGODB_URI", "mongodb://localhost:27017/book-reader")

	SlmAPI = env("SLM_API", "https://slm.kevyn.com.br")
	SlmAPIFallback = env("SLM_API_FALLBACK", "https://ollama-macbook.kevyn.com.br")
	SlmModel = env("SLM_MODEL", "qwen2.5:3b")
	SlmSplitModel = env("SLM_SPLIT_MODEL", "gemma4:latest")
	SlmPrimaryWeight = max(1, envInt("SLM_PRIMARY_WEIGHT", 4))
	SlmFallbackWeight = max(1, envInt("SLM_FALLBACK_WEIGHT", 1))

	SlmServers = nil
	seen := map[string]bool{}
	for _, s := range []SlmServer{
		{URL: stripSlash(SlmAPI), Weight: SlmPrimaryWeight},
		{URL: stripSlash(SlmAPIFallback), Weight: SlmFallbackWeight},
	} {
		if s.URL == "" || seen[s.URL] {
			continue
		}
		seen[s.URL] = true
		SlmServers = append(SlmServers, s)
	}

	TtsServers = parseTtsServers(os.Getenv("TTS_SERVERS"))

	WhisperModel = env("WHISPER_MODEL", "deepdml/faster-whisper-large-v3-turbo-ct2")
	WhisperTimeoutMs = envInt("WHISPER_TIMEOUT_MS", 60000)

	TtsVerify = env("TTS_VERIFY", "1") != "0"
	TtsVerifyThreshold = envFloat("TTS_VERIFY_THRESHOLD", 0.85)
	TtsVerifyMaxDepth = envInt("TTS_VERIFY_MAX_DEPTH", 3)
	TtsVerifyAttempts = max(1, envInt("TTS_VERIFY_ATTEMPTS", 3))
	TtsVerifyMinChars = envInt("TTS_VERIFY_MIN_CHARS", 8)

	TtsMaxSentenceChars = envInt("TTS_MAX_SENTENCE_CHARS", 220)

	DataDir = env("DATA_DIR", "./data")
	DeleteAllowedIPs = nil
	for _, ip := range strings.Split(os.Getenv("DELETE_ALLOWED_IPS"), ",") {
		if p := strings.TrimSpace(ip); p != "" {
			DeleteAllowedIPs = append(DeleteAllowedIPs, p)
		}
	}
	DefaultVoice = env("TTS_VOICE", "chatterbox:pt-BR-FranciscaNeural")
	TtsSpeed = envFloat("TTS_SPEED", 1.0)
	TtsConcurrency = envInt("TTS_CONCURRENCY", 5)
	OcrConcurrency = max(1, envInt("OCR_CONCURRENCY", 8))
	AmqpURL = env("AMQP_URL", "amqp://guest:guest@localhost:5672/")
	TtsVolumeGain = envFloat("TTS_VOLUME_GAIN", 1.15)
	TitleMaxWords = envInt("TITLE_MAX_WORDS", 5)
	TitleSilenceSecs = envFloat("TITLE_SILENCE_SECS", 0.7)
	TitleVolumeGain = envFloat("TITLE_VOLUME_GAIN", 1.1)
	DefaultLanguage = env("TTS_LANGUAGE", "en")
	FrontendOrigin = env("FRONTEND_ORIGIN", "http://localhost:5173")
}

const QwenVlMaxTokens = 4096

var OcrSystemPrompt = strings.Join([]string{
	"You are a document OCR and transcription engine.",
	"Return one valid JSON object and nothing else.",
	`The JSON object must have this exact shape: {"language":"pt","content":"..."}`,
	`Use language as a lowercase ISO 639-1 code such as "pt", "en", "es", or "unknown".`,
	"Escape quotes and line breaks inside content so the response remains valid JSON.",
	"Never add explanations, summaries, references, citations, commentary, confidence notes, markdown fences, or greetings.",
}, " ")

var OcrPagePrompt = strings.Join([]string{
	"Extract the document text for text-to-speech.",
	"Detect the primary language of the main content.",
	"Put only the main readable body content in the JSON content field, in the same language as the file.",
	"Preserve the original reading order: title, headings, paragraphs, lists, and quoted text.",
	"Ignore page numbers, running headers, running footers, footnotes, references, copyright notices, scanner marks, watermarks, and decorative text.",
	"Ignore superscript footnote markers, whether they are numbers, letters, or symbols placed beside words.",
	"Do not include footnote text, endnote text, bibliography entries, reference lists, or citation-only notes.",
	"Join words that were split by line-break hyphenation.",
	"Preserve real hyphenated compound words only when the hyphen is part of the original word.",
	"Preserve visible punctuation such as commas, periods, semicolons, colons, question marks, and exclamation marks.",
	"Do not describe the page, image quality, layout, fonts, margins, or visual elements.",
	"Do not summarize, correct, modernize, translate, or add any text that is not part of the main content.",
	"If a page has multiple columns, read each column from top to bottom, left to right.",
	"Extract only this page. Do not mention the page number.",
}, " ")

var TitleSystemPrompt = strings.Join([]string{
	"You are reading the front cover of a book.",
	"Return one valid JSON object and nothing else.",
	`The JSON object must have this exact shape: {"title":"..."}`,
	"Put only the main book title in the title field, exactly as printed on the cover.",
	"Do not include the subtitle, author name, publisher, edition, or series name.",
	`If you cannot read a title, return {"title":""}.`,
	"Never add explanations, markdown fences, or any text outside the JSON object.",
}, " ")

var TitlePagePrompt = strings.Join([]string{
	"This image is the front cover of a book.",
	"Read the main title of the book exactly as printed.",
}, " ")

var TocSystemPrompt = strings.Join([]string{
	"You are reading the table of contents (index/summary) page of a book.",
	"Return one valid JSON array and nothing else.",
	`The JSON array must have this exact shape: [{"title":"Chapter Title","page":1}]`,
	`"title" is the chapter or section title exactly as printed.`,
	`"page" is the integer page number printed next to that title in the contents.`,
	"Include every listed entry that has a page number, preserving their order.",
	"Do not invent entries and do not include entries without a page number.",
	"If the image is not a table of contents, return an empty array [].",
	"Never add explanations, markdown fences, or any text outside the JSON array.",
}, " ")

var TocPagePrompt = strings.Join([]string{
	"This image is the table of contents / index page of a book.",
	"Extract every chapter or section listed together with the page number shown for it.",
	"Read titles exactly as printed and keep them in the order they appear.",
}, " ")

var LangSystemPrompt = strings.Join([]string{
	"You identify the primary written language of a book page.",
	"Return one valid JSON object and nothing else.",
	`The JSON object must have this exact shape: {"language":"pt"}`,
	`Use a lowercase ISO 639-1 code such as "pt", "en", "es", or "unknown".`,
	"Never add explanations, markdown fences, or any text outside the JSON object.",
}, " ")

var LangPagePrompt = strings.Join([]string{
	"Identify the primary language the readable body text on this page is written in.",
	"Ignore isolated foreign quotations, names, and scripture references.",
}, " ")
