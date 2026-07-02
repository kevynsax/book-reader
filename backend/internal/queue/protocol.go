// Package queue is the RabbitMQ task fabric between the orchestrating main
// process and the role workers (tts / vlm / slm / whisper). Main publishes
// one task per AI call and waits for the reply; workers claim tasks only
// while their AI server is healthy, one at a time. Balancing and fallback are
// emergent: a busy or dead worker doesn't claim, and an unacked task is
// redelivered by the broker to another worker of the same role.
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

// TTSTaskQueue routes synthesis by capability: one queue per model
// ("tasks.tts.chatterbox", "tasks.tts.openaudio", …). A tts worker consumes
// only the queues for models its server advertises, so a task for a model a
// server can't run is never claimed by that server's worker.
func TTSTaskQueue(model string) string { return "tasks.tts." + model }

const (
	DeadLetterQueue = "tasks.dead"
	HeartbeatQueue  = "worker.heartbeat"
	// A task is redelivered at most this many times before dead-lettering.
	DeliveryLimit = 3
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

	TypeSplitInTwo = "split-in-two"
	TypeSplitToMax = "split-to-max"

	TypeTranscribe = "transcribe"

	TypeSynthesize = "synthesize"
)

// Payload/result shapes. Binary fields are []byte (base64 over the wire).

type OcrPagePayload struct {
	Image []byte `json:"image"`
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
}

type Model struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}
