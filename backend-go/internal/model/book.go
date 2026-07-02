package model

import (
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/kevynsax/book-reader/backend-go/internal/lib/sanitize"
)

type BookStatus string

const (
	StatusUploading             BookStatus = "uploading"
	StatusSplittingPages        BookStatus = "splitting_pages"
	StatusExtractingCover       BookStatus = "extracting_cover"
	StatusReadingTitle          BookStatus = "reading_title"
	StatusOcrProcessing         BookStatus = "ocr_processing"
	StatusDetectingChapters     BookStatus = "detecting_chapters"
	StatusAwaitingChapterReview BookStatus = "awaiting_chapter_review"
	StatusGeneratingAudio       BookStatus = "generating_audio"
	StatusComplete              BookStatus = "complete"
	StatusError                 BookStatus = "error"
)

type AudioStatus string

const (
	AudioPending    AudioStatus = "pending"
	AudioStale      AudioStatus = "stale"
	AudioGenerating AudioStatus = "generating"
	AudioComplete   AudioStatus = "complete"
	AudioError      AudioStatus = "error"
)

type OcrStatus string

const (
	OcrPending    OcrStatus = "pending"
	OcrProcessing OcrStatus = "processing"
	OcrComplete   OcrStatus = "complete"
	OcrErr        OcrStatus = "error"
)

// Segment is one audio chunk for a single sentence, in one voice (_id:false).
type Segment struct {
	SentenceID   bson.ObjectID `bson:"sentenceId"             json:"sentenceId"`
	AudioPath    *string       `bson:"audioPath,omitempty"    json:"audioPath,omitempty"`
	DurationSecs *float64      `bson:"durationSecs,omitempty" json:"durationSecs,omitempty"`
	AudioStatus  AudioStatus   `bson:"audioStatus"            json:"audioStatus"`
	AudioError   *string       `bson:"audioError,omitempty"   json:"audioError,omitempty"`
}

// VoiceTrack is a chapter's rendered audio for one voice (_id:false).
type VoiceTrack struct {
	Voice             string      `bson:"voice"                       json:"voice"`
	AudioPath         *string     `bson:"audioPath,omitempty"         json:"audioPath,omitempty"`
	AudioDurationSecs *float64    `bson:"audioDurationSecs,omitempty" json:"audioDurationSecs,omitempty"`
	AudioStatus       AudioStatus `bson:"audioStatus"                 json:"audioStatus"`
	AudioError        *string     `bson:"audioError,omitempty"        json:"audioError,omitempty"`
	Segments          []Segment   `bson:"segments"                    json:"segments"`
}

// Sentence is an editable, speech-ready sentence — the source of truth for
// chapter audio. `Text` is what's synthesized; `Display` is shown to the
// reader; `Original` is the pre-SLM-split source sentence.
type Sentence struct {
	ID       bson.ObjectID `bson:"_id"                json:"_id"`
	Order    int           `bson:"order"              json:"order"`
	Text     string        `bson:"text"               json:"text"`
	Display  *string       `bson:"display,omitempty"  json:"display,omitempty"`
	Original *string       `bson:"original,omitempty" json:"original,omitempty"`
}

type Chapter struct {
	ID        bson.ObjectID `bson:"_id"       json:"_id"`
	Title     string        `bson:"title"     json:"title"`
	StartPage int           `bson:"startPage" json:"startPage"`
	StartChar int           `bson:"startChar" json:"startChar"`
	Sentences []Sentence    `bson:"sentences" json:"sentences"`
	Tracks    []VoiceTrack  `bson:"tracks"    json:"tracks"`
}

type OcrPage struct {
	ID       bson.ObjectID `bson:"_id,omitempty"      json:"_id,omitempty"`
	Page     int           `bson:"page"               json:"page"`
	Text     string        `bson:"text"               json:"text"`
	ReadText *string       `bson:"readText,omitempty" json:"readText,omitempty"`
	Language string        `bson:"language"           json:"language"`
	Status   OcrStatus     `bson:"status"             json:"status"`
	Error    *string       `bson:"error,omitempty"    json:"error,omitempty"`
}

type Progress struct {
	Current int    `bson:"current" json:"current"`
	Total   int    `bson:"total"   json:"total"`
	Message string `bson:"message" json:"message"`
}

type Book struct {
	ID             bson.ObjectID `bson:"_id"                      json:"_id"`
	Name           string        `bson:"name"                     json:"name"`
	Status         BookStatus    `bson:"status"                   json:"status"`
	Language       *string       `bson:"language,omitempty"       json:"language,omitempty"`
	FolderPath     string        `bson:"folderPath"               json:"folderPath"`
	FilePath       string        `bson:"filePath"                 json:"filePath"`
	CoverImagePath *string       `bson:"coverImagePath,omitempty" json:"coverImagePath,omitempty"`
	SummaryPages   []int         `bson:"summaryPages"             json:"summaryPages"`
	CoverPage      int           `bson:"coverPage"                json:"coverPage"`
	FirstPage      int           `bson:"firstPage"                json:"firstPage"`
	LastPage       int           `bson:"lastPage"                 json:"lastPage"`
	TotalPages     int           `bson:"totalPages"               json:"totalPages"`
	Chapters       []Chapter     `bson:"chapters"                 json:"chapters"`
	OcrPages       []OcrPage     `bson:"ocrPages"                 json:"ocrPages"`
	Progress       Progress      `bson:"progress"                 json:"progress"`
	ErrorMessage   *string       `bson:"errorMessage,omitempty"   json:"errorMessage,omitempty"`
	Voices         []string      `bson:"voices"                   json:"voices"`
	Deleted        bool          `bson:"deleted"                  json:"deleted"`
	CreatedAt      DateTime      `bson:"createdAt"                json:"createdAt"`
	UpdatedAt      DateTime      `bson:"updatedAt"                json:"updatedAt"`
	V              int32         `bson:"__v"                      json:"__v"`
}

func (b *Book) TrackForVoice(chapter *Chapter, voice string) *VoiceTrack {
	for i := range chapter.Tracks {
		if chapter.Tracks[i].Voice == voice {
			return &chapter.Tracks[i]
		}
	}
	return nil
}

func FreshTracks(voices []string) []VoiceTrack {
	tracks := make([]VoiceTrack, len(voices))
	for i, voice := range voices {
		tracks[i] = VoiceTrack{Voice: voice, AudioStatus: AudioPending, Segments: []Segment{}}
	}
	return tracks
}

// DeriveTrackStatus computes a track's status from its segments (the
// assembled-chapter readiness).
func DeriveTrackStatus(segments []Segment) AudioStatus {
	if len(segments) == 0 {
		return AudioPending
	}
	counts := map[AudioStatus]int{}
	for _, s := range segments {
		counts[s.AudioStatus]++
	}
	switch {
	case counts[AudioGenerating] > 0:
		return AudioGenerating
	case counts[AudioError] > 0:
		return AudioError
	case counts[AudioStale] > 0:
		return AudioStale
	case counts[AudioComplete] == len(segments):
		return AudioComplete
	default:
		return AudioPending
	}
}

// ClientTrack / ClientChapter are the wire DTOs of serializeChaptersForClient:
// chapters trimmed for sync payloads — sentences and per-segment data stay
// server-side.
type ClientTrack struct {
	Voice             string      `json:"voice"`
	AudioPath         *string     `json:"audioPath,omitempty"`
	AudioDurationSecs *float64    `json:"audioDurationSecs,omitempty"`
	AudioStatus       AudioStatus `json:"audioStatus"`
	AudioError        *string     `json:"audioError,omitempty"`
}

type ClientChapter struct {
	ID        bson.ObjectID `json:"_id"`
	Title     string        `json:"title"`
	StartPage int           `json:"startPage"`
	StartChar int           `json:"startChar"`
	Tracks    []ClientTrack `json:"tracks"`
}

func SerializeChaptersForClient(chapters []Chapter) []ClientChapter {
	out := make([]ClientChapter, len(chapters))
	for i, c := range chapters {
		tracks := make([]ClientTrack, len(c.Tracks))
		for j, t := range c.Tracks {
			tracks[j] = ClientTrack{
				Voice:             t.Voice,
				AudioPath:         t.AudioPath,
				AudioDurationSecs: t.AudioDurationSecs,
				AudioStatus:       t.AudioStatus,
				AudioError:        t.AudioError,
			}
		}
		out[i] = ClientChapter{ID: c.ID, Title: c.Title, StartPage: c.StartPage, StartChar: c.StartChar, Tracks: tracks}
	}
	return out
}

// ClientBook is a Book with chapters trimmed and OCR text sanitized — the
// shape sent on the WS sync path (port of sanitizeBook in routes/books.ts).
type ClientBook struct {
	Book
	Chapters []ClientChapter `json:"chapters"`
}

func SanitizeBook(b *Book) ClientBook {
	out := ClientBook{Book: *b, Chapters: SerializeChaptersForClient(b.Chapters)}
	out.Book.Chapters = nil
	pages := make([]OcrPage, len(b.OcrPages))
	for i, p := range b.OcrPages {
		p.Text = sanitize.PageText(p.Text)
		pages[i] = p
	}
	out.Book.OcrPages = pages
	return out
}

// Normalize ensures every slice the frontend expects as [] is non-nil, so
// nil slices never encode as null in JSON or BSON (Mongoose always stores []).
func (b *Book) Normalize() {
	if b.SummaryPages == nil {
		b.SummaryPages = []int{}
	}
	if b.Voices == nil {
		b.Voices = []string{}
	}
	if b.Chapters == nil {
		b.Chapters = []Chapter{}
	}
	if b.OcrPages == nil {
		b.OcrPages = []OcrPage{}
	}
	for i := range b.Chapters {
		c := &b.Chapters[i]
		if c.Sentences == nil {
			c.Sentences = []Sentence{}
		}
		if c.Tracks == nil {
			c.Tracks = []VoiceTrack{}
		}
		for j := range c.Tracks {
			if c.Tracks[j].Segments == nil {
				c.Tracks[j].Segments = []Segment{}
			}
		}
	}
}
