// Package queue is the RabbitMQ task fabric between the orchestrating main
// process and the role workers (tts / vlm / slm / whisper). Main publishes
// one task per AI call and waits for the reply; workers claim tasks only
// while their AI server is healthy, one at a time. For vlm/slm/whisper,
// balancing is emergent: a busy or dead worker doesn't claim, and an unacked
// task is redelivered by the broker to another worker of the same role. TTS
// is different: main's dispatcher (dispatch.go) assigns each synthesize task
// to one specific free server via that server's own queue, so the whole fleet
// works the book's voices in one global order instead of each server hopping
// between models.
package queue

import "encoding/json"

type Role string

const (
	RoleTTS     Role = "tts"
	RoleVLM     Role = "vlm"
	RoleSLM     Role = "slm"
	RoleWhisper Role = "whisper"
)

var Roles = []Role{RoleTTS, RoleVLM, RoleSLM, RoleWhisper}

func TaskQueueName(role Role) string { return "tasks." + string(role) }

// TTSServerQueue is one tts worker's private task queue
// ("tasks.tts.server.macbook"). Main's dispatcher picks which server renders
// each segment — capability matching and ordering live in the dispatcher, not
// in shared queues — and publishes to that server's queue only while the
// server is free, so a task never waits behind a busy server.
func TTSServerQueue(serverID string) string { return "tasks.tts.server." + serverID }

const (
	DeadLetterQueue = "tasks.dead"
	HeartbeatQueue  = "worker.heartbeat"
	// A task is redelivered at most this many times before dead-lettering.
	DeliveryLimit = 3
	// SummaryVLMQueue carries user-initiated summary re-reads only. Every vlm
	// worker consumes it with its WORKER_PRIORITY as consumer priority, so the
	// task lands on the preferred server (spark > macbook > kevyn-server) and
	// the others are fallbacks — without biasing the shared tasks.vlm queue.
	SummaryVLMQueue = "tasks.vlm.summary"
)

// Task is the message main publishes to a role queue.
type Task struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// Reply carries the outcome. Application errors travel as Error — they are
// answers, not delivery failures, and are never requeued.
type Reply struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// Task types per role.
const (
	TypeOcrPage        = "ocr-page"
	TypeExtractTitle   = "extract-title"
	TypeDetectLanguage = "detect-language"
	TypeExtractToc     = "extract-toc"

	TypeSplitInTwo       = "split-in-two"
	TypeSplitToMax       = "split-to-max"
	TypeVerifyTranscript = "verify-transcript"
	TypeClassifyQuote    = "classify-quote"

	TypeTranscribe = "transcribe"

	TypeSynthesize = "synthesize"
)

// Payload/result shapes. Binary fields are []byte (base64 over the wire).

type OcrPagePayload struct {
	Image []byte `json:"image"`
	// Book page number, so the worker can report "reading p.N" in heartbeats.
	Page int `json:"page,omitempty"`
}

type OcrPageResult struct {
	Language string `json:"language"`
	Content  string `json:"content"`
}

type ImagePayload struct {
	Image []byte `json:"image"`
}

type TitleResult struct {
	Title string `json:"title"`
}

type LanguageResult struct {
	Language string `json:"language"`
}

type TocEntry struct {
	Title string `json:"title"`
	Page  int    `json:"page"`
}

type TocResult struct {
	Entries []TocEntry `json:"entries"`
}

type SplitInTwoPayload struct {
	Line  string `json:"line"`
	Model string `json:"model"`
}

type SplitInTwoResult struct {
	Left  string `json:"left"`
	Right string `json:"right"`
}

type SplitToMaxPayload struct {
	Line     string `json:"line"`
	MaxChars int    `json:"maxChars"`
	Model    string `json:"model"`
}

type SplitToMaxResult struct {
	Parts []string `json:"parts"`
}

// VerifyTranscriptPayload asks the SLM to judge a low-similarity Whisper
// transcript: is the audio actually missing a chunk of the text, or does the
// transcript convey the same content with benign differences (spelled-out
// numbers, mis-heard names, punctuation)?
type VerifyTranscriptPayload struct {
	Expected   string `json:"expected"`
	Transcript string `json:"transcript"`
	Model      string `json:"model"`
}

type VerifyTranscriptResult struct {
	Missing bool   `json:"missing"`
	Reason  string `json:"reason"`
}

// ClassifyQuotePayload asks the SLM who speaks a quoted sentence, with a
// little surrounding context to identify the speaker.
type ClassifyQuotePayload struct {
	Before   []string `json:"before"`
	Sentence string   `json:"sentence"`
	After    []string `json:"after"`
	Model    string   `json:"model"`
}

// ClassifyQuoteResult carries the judged speaker: man, woman, kid, unknown,
// or none (not actually quoted speech).
type ClassifyQuoteResult struct {
	Speaker string `json:"speaker"`
}

type TranscribePayload struct {
	Audio    []byte `json:"audio"`
	Language string `json:"language"`
}

type TranscribeResult struct {
	Text string `json:"text"`
}

type SynthesizePayload struct {
	Model    string  `json:"model"`
	Input    string  `json:"input"`
	Voice    string  `json:"voice"`
	Speed    float64 `json:"speed"`
	Language string  `json:"language"`
	// Whether the engine takes a language param (Model.UsesLanguage).
	UsesLanguage bool `json:"usesLanguage"`
	// Optional sampling temperature override. Verify retries escalate it so a
	// deterministic bad take (e.g. an LLM-TTS engine translating its input)
	// gets a genuinely different sample instead of the same audio again.
	Temperature *float64 `json:"temperature,omitempty"`
}

type SynthesizeResult struct {
	Audio        []byte  `json:"audio"`
	DurationSecs float64 `json:"durationSecs"`
}

// Heartbeat is published by every worker each health cycle and feeds main's
// registry (and the /api/servers panel for the tts role).
type Heartbeat struct {
	Role        Role    `json:"role"`
	ServerID    string  `json:"serverId"`
	Label       string  `json:"label"`
	URL         string  `json:"url"`
	Healthy     bool    `json:"healthy"`
	State       string  `json:"state,omitempty"`
	ActiveModel string  `json:"activeModel,omitempty"`
	Models      []Model `json:"models"`
	Busy        bool    `json:"busy"`
	// Short label of the task in flight ("p.34" for an OCR page), plus this
	// worker's own completed-task tally — main can't attribute shared-queue
	// tasks to servers, so each worker reports its own.
	Task    string  `json:"task,omitempty"`
	Done    int64   `json:"done,omitempty"`
	AvgSecs float64 `json:"avgSecs,omitempty"`
}

type Model struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}
