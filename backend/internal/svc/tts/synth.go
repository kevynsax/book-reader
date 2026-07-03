package tts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/kevynsax/book-reader/backend/internal/config"
	"github.com/kevynsax/book-reader/backend/internal/lib/pool"
	"github.com/kevynsax/book-reader/backend/internal/lib/sentences"
	"github.com/kevynsax/book-reader/backend/internal/lib/verify"
	"github.com/kevynsax/book-reader/backend/internal/queue"
	"github.com/kevynsax/book-reader/backend/internal/svc/audioprobe"
	"github.com/kevynsax/book-reader/backend/internal/svc/normalizer"
)

// A request to TTS that takes longer than this is treated as a failure so a
// stuck server doesn't hang a whole chapter.
const chunkTimeout = 180 * time.Second
const chunkRetries = 2

// SLM split output is rejected when its pieces drift this far from the
// original text, so a hallucinated piece never enters the book.
const splitPiecesMinSimilarity = 0.8
const splitPieceMinChars = 5

type TimelineEntry struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// TimelinePathFor is the read-along timeline JSON path for a chapter audio file.
func TimelinePathFor(audioPath string) string {
	return audioPath + ".timeline.json"
}

type chunkResult struct {
	buffer       []byte
	durationSecs float64
}

// SynthesizeOn renders one chunk against exactly one TTS server — the worker
// path. usesLanguage mirrors Model.UsesLanguage for ids outside the static
// catalog.
func SynthesizeOn(ctx context.Context, serverURL, modelID, input, voice string, speed float64, language string, usesLanguage bool) ([]byte, float64, error) {
	out, err := synthesizeChunk(ctx, input, serverURL, Model{ID: modelID, UsesLanguage: usesLanguage}, voice, speed, language)
	if err != nil {
		return nil, 0, err
	}
	return out.buffer, out.durationSecs, nil
}

func synthesizeChunk(ctx context.Context, text, serverURL string, model Model, voice string, speed float64, language string) (chunkResult, error) {
	body := map[string]any{
		"model":           model.ID,
		"input":           text,
		"voice":           voice,
		"response_format": "mp3",
		"speed":           speed,
	}
	if model.UsesLanguage {
		body["language"] = language
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return chunkResult{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, chunkTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, serverURL+"/v1/audio/speech", bytes.NewReader(payload))
	if err != nil {
		return chunkResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return chunkResult{}, err
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 8192))
		msg := strings.TrimSpace(string(raw))
		if msg == "" {
			msg = fmt.Sprintf("TTS API returned %d", res.StatusCode)
		}
		return chunkResult{}, fmt.Errorf("%s", msg)
	}

	buffer, err := io.ReadAll(res.Body)
	if err != nil {
		return chunkResult{}, err
	}
	// Chatterbox returns the duration; for engines that don't, probe it.
	if header := res.Header.Get("X-Audio-Duration-Seconds"); header != "" {
		if secs, err := strconv.ParseFloat(header, 64); err == nil {
			return chunkResult{buffer: buffer, durationSecs: secs}, nil
		}
	}
	secs, err := audioprobe.ProbeMp3Buffer(buffer)
	if err != nil {
		return chunkResult{}, err
	}
	return chunkResult{buffer: buffer, durationSecs: secs}, nil
}

// renderContext threads the task fabric and voice parameters through the
// verify/split recursion. priority is the segment's position in the book's
// global work order — the dispatcher serves the earliest waiting render
// first, so every server works the same voice/chapter order.
type renderContext struct {
	q        *queue.Client
	model    Model
	voice    string
	speed    float64
	language string
	priority int64
}

// renderChunkToBuffer synthesizes one chunk on a dispatcher-granted server,
// retrying transient failures so a single dropped request doesn't fail the
// chapter. The server is held only for the RPC itself — verification
// (whisper/SLM) happens between acquisitions so the server can render other
// segments meanwhile.
func renderChunkToBuffer(ctx context.Context, text string, rc renderContext) (chunkResult, error) {
	var lastErr error
	for attempt := 0; attempt <= chunkRetries; attempt++ {
		serverID, release, err := rc.q.AcquireTTS(ctx, rc.priority, rc.model.ID)
		if err != nil {
			return chunkResult{}, err
		}
		res, err := rc.q.Synthesize(ctx, queue.SynthesizePayload{
			Model:        rc.model.ID,
			Input:        text,
			Voice:        rc.voice,
			Speed:        rc.speed,
			Language:     rc.language,
			UsesLanguage: rc.model.UsesLanguage,
		}, serverID)
		release()
		if err == nil {
			return chunkResult{buffer: res.Audio, durationSecs: res.DurationSecs}, nil
		}
		lastErr = err
	}
	return chunkResult{}, lastErr
}

// validSplitPieces accepts an SLM split only when every piece is speakable
// text and the pieces together still say what the original said.
func validSplitPieces(display string, parts []string) bool {
	for _, p := range parts {
		if len([]rune(strings.TrimSpace(p))) < splitPieceMinChars || len(verify.NormalizeWords(p)) == 0 {
			return false
		}
	}
	return verify.WordSimilarity(display, strings.Join(parts, " ")) >= splitPiecesMinSimilarity
}

// SlmSplitToMax asks the SLM — via an slm-role task — to divide the ORIGINAL
// sentence into as many natural sub-sentences as needed so each is at most
// maxChars long.
func SlmSplitToMax(ctx context.Context, q *queue.Client, display string, maxChars int) []string {
	parts, err := q.SplitToMax(ctx, display, maxChars, config.SlmSplitModel)
	if err != nil {
		log.Printf("SLM split failed: %v", err)
		return nil
	}
	if len(parts) > 1 && !validSplitPieces(display, parts) {
		log.Printf("SLM split rejected (pieces stray from original) for %q", truncate(display, 60))
		return nil
	}
	return parts
}

// RenderedPiece is one rendered sentence: the original display text, the
// speech-ready text actually synthesized, and the audio. Transcripts traces
// verification quality — every transcript Whisper returned on the way to
// this audio, in attempt order. Mismatch means every attempt kept
// disagreeing with Whisper: the best take is kept and the sentence must be
// surfaced for user review.
type RenderedPiece struct {
	Display      string
	Text         string
	Buffer       []byte
	DurationSecs float64
	Transcripts  []string
	Mismatch     bool
}

// renderVerified renders a chunk and confirms — via Whisper — that it says
// what was asked. On a low-similarity transcript an SLM judge decides
// whether the audio actually LOST content or merely differs in benign ways
// (spelled-out numbers, mis-heard names): benign → the audio is accepted;
// missing content → re-synthesize up to TtsVerifyAttempts times. When every
// attempt disagrees the best take is returned flagged Mismatch — the
// sentence goes to the user review list instead of being SLM-split.
func renderVerified(ctx context.Context, display, text string, rc renderContext) (RenderedPiece, error) {
	var transcripts []string

	var best RenderedPiece
	bestSimilarity := -1.0
	for attempt := 1; attempt <= config.TtsVerifyAttempts; attempt++ {
		result, err := renderChunkToBuffer(ctx, text, rc)
		if err != nil {
			return RenderedPiece{}, err
		}
		leaf := RenderedPiece{Display: display, Text: text, Buffer: result.buffer, DurationSecs: result.durationSecs}

		if !config.TtsVerify || len(strings.TrimSpace(text)) < config.TtsVerifyMinChars {
			leaf.Transcripts = transcripts
			return leaf, nil
		}

		transcript, err := rc.q.Transcribe(ctx, result.buffer, rc.language)
		if err != nil {
			// ASR unavailable (no whisper worker / timeout) — don't block.
			log.Printf("tts verify: transcription unavailable: %v", err)
			leaf.Transcripts = transcripts
			return leaf, nil
		}
		transcripts = append(transcripts, transcript)
		leaf.Transcripts = transcripts

		similarity := verify.WordSimilarityLang(text, transcript, rc.language)
		if similarity >= config.TtsVerifyThreshold {
			return leaf, nil
		}
		if similarity > bestSimilarity {
			bestSimilarity = similarity
			best = leaf
		}

		// Below threshold: let the SLM judge whether content is actually
		// missing. Whisper quirks on reference-heavy text sit just under the
		// threshold constantly — only truly lost chunks justify a re-render.
		verdict, err := rc.q.VerifyTranscript(ctx, text, transcript, config.SlmSplitModel)
		if err != nil {
			log.Printf("tts verify: SLM judge unavailable (%v) — treating mismatch as missing content", err)
		} else if !verdict.Missing {
			log.Printf("tts verify: sim=%.2f but SLM judged content complete (%s) — accepting %q",
				similarity, truncate(verdict.Reason, 80), truncate(display, 60))
			return leaf, nil
		} else {
			log.Printf("tts verify: attempt %d/%d missing content (sim=%.2f, %s) for %q",
				attempt, config.TtsVerifyAttempts, similarity, truncate(verdict.Reason, 80), truncate(display, 60))
		}
	}

	log.Printf("tts verify: mismatch after %d attempts (sim=%.2f) — flagged for review: %q",
		config.TtsVerifyAttempts, bestSimilarity, truncate(display, 60))
	best.Transcripts = transcripts
	best.Mismatch = true
	return best, nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// RenderSegment verifies and renders one sentence, returning the audio with
// its verification trace. priority orders the render against every other
// waiting segment (lower renders first).
func RenderSegment(ctx context.Context, q *queue.Client, display, text, voice, language string, priority int64) (RenderedPiece, error) {
	model, bareVoice := ParseVoice(voice)
	speakable := strings.TrimSpace(text)
	if speakable == "" {
		return RenderedPiece{}, fmt.Errorf("empty sentence")
	}
	d := strings.TrimSpace(display)
	if d == "" {
		d = speakable
	}
	return renderVerified(ctx, d, speakable,
		renderContext{q: q, model: model, voice: bareVoice, speed: config.TtsSpeed, language: language, priority: priority})
}

// SynthesizeSegment renders one sentence to its own mp3 file, verifying it
// against Whisper (used by the single-sentence edit/regenerate path).
// Returns the duration, every transcript observed while producing the audio,
// and whether the take still mismatches and needs user review.
func SynthesizeSegment(ctx context.Context, q *queue.Client, text, outputPath, voice, language string) (float64, []string, bool, error) {
	// Priority 0: single-sentence edits are user-initiated and jump ahead of
	// any bulk run's segments.
	piece, err := RenderSegment(ctx, q, text, text, voice, language, 0)
	if err != nil {
		return 0, nil, false, err
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return 0, nil, false, err
	}
	if err := os.WriteFile(outputPath, piece.Buffer, 0o644); err != nil {
		return 0, nil, false, err
	}
	return piece.DurationSecs, piece.Transcripts, piece.Mismatch, nil
}

// SynthesizeSample renders a voice preview for the first readable text.
func SynthesizeSample(ctx context.Context, text, voice string) ([]byte, error) {
	model, bareVoice := ParseVoice(voice)
	server, err := PickReadyServer(ctx, model.ID)
	if err != nil {
		return nil, err
	}
	speakable := normalizer.NormalizeForSpeech(ctx, truncate(text, 1500), config.DefaultLanguage)
	out, err := synthesizeChunk(ctx, speakable, server.URL, model, bareVoice, config.TtsSpeed, config.DefaultLanguage)
	if err != nil {
		return nil, err
	}
	return out.buffer, nil
}

// concatLine renders a concat-demuxer manifest entry. Paths are absolute and
// single-quote escaped so ffmpeg resolves them regardless of cwd.
func concatLine(file string) string {
	abs, err := filepath.Abs(file)
	if err != nil {
		abs = file
	}
	return "file '" + strings.ReplaceAll(abs, "'", `'\''`) + "'"
}

type SegmentInput struct {
	AudioPath    string
	DurationSecs float64
	Text         string
	Display      string
}

func round3(x float64) float64 {
	return math.Round(x*1000) / 1000
}

// AssembleChapter concatenates per-sentence mp3 segments into the final
// chapter mp3 and writes the read-along timeline. Segments are joined in the
// PCM domain so the join is sample-accurate. Timeline offsets are summed from
// each file's *real* decoded duration — not the stored segment durations —
// so highlights stay locked to the audio across a long chapter.
func AssembleChapter(segments []SegmentInput, outputPath string) (float64, error) {
	if len(segments) == 0 {
		return 0, fmt.Errorf("no segments to assemble")
	}

	tmpDir := filepath.Dir(outputPath)
	base := filepath.Base(outputPath)
	listPath := filepath.Join(tmpDir, "_list_"+base+".txt")
	silencePath := filepath.Join(tmpDir, "_silence_"+base+".mp3")
	var boostedPaths []string
	defer func() {
		os.Remove(listPath)
		os.Remove(silencePath)
		for _, f := range boostedPaths {
			os.Remove(f)
		}
	}()

	silenceFile := ""
	silenceDur := 0.0
	anyTitle := false
	for _, s := range segments {
		if sentences.IsTitle(s.Text, config.TitleMaxWords) {
			anyTitle = true
			break
		}
	}
	if anyTitle {
		sampleRate, channels, err := audioprobe.ProbeAudioFormat(segments[0].AudioPath)
		if err != nil {
			return 0, err
		}
		silence, err := audioprobe.GenerateSilence(config.TitleSilenceSecs, sampleRate, channels)
		if err != nil {
			return 0, err
		}
		if err := os.WriteFile(silencePath, silence, 0o644); err != nil {
			return 0, err
		}
		silenceFile = silencePath
		if silenceDur, err = audioprobe.DecodedDurationSecs(silencePath); err != nil {
			return 0, err
		}
	}

	// The actual file fed into the concat for each sentence — the original
	// segment, or a temp gain-boosted copy for titles (the demuxer can't apply
	// per-file gain, so it's pre-baked here).
	files := make([]string, len(segments))
	err := pool.Run(segments, 8, func(seg SegmentInput, i int) error {
		if silenceFile == "" || !sentences.IsTitle(seg.Text, config.TitleMaxWords) {
			files[i] = seg.AudioPath
			return nil
		}
		file := filepath.Join(tmpDir, fmt.Sprintf("_title_%d_%s.mp3", i, base))
		data, err := os.ReadFile(seg.AudioPath)
		if err != nil {
			return err
		}
		boosted, err := audioprobe.ApplyVolume(data, config.TitleVolumeGain)
		if err != nil {
			return err
		}
		if err := os.WriteFile(file, boosted, 0o644); err != nil {
			return err
		}
		files[i] = file
		return nil
	})
	if err != nil {
		return 0, err
	}
	for i, f := range files {
		if f != segments[i].AudioPath {
			boostedPaths = append(boostedPaths, f)
		}
	}

	durations := make([]float64, len(files))
	if err := pool.Run(files, 16, func(f string, i int) error {
		d, err := audioprobe.DecodedDurationSecs(f)
		if err != nil {
			return err
		}
		durations[i] = d
		return nil
	}); err != nil {
		return 0, err
	}

	var lines []string
	timeline := make([]TimelineEntry, 0, len(segments))
	cursor := 0.0
	for i, seg := range segments {
		title := silenceFile != "" && sentences.IsTitle(seg.Text, config.TitleMaxWords)
		if title {
			lines = append(lines, concatLine(silenceFile))
			cursor += silenceDur
		}
		lines = append(lines, concatLine(files[i]))
		display := seg.Display
		if display == "" {
			display = seg.Text
		}
		timeline = append(timeline, TimelineEntry{Text: display, Start: round3(cursor), End: round3(cursor + durations[i])})
		cursor += durations[i]
		if title {
			lines = append(lines, concatLine(silenceFile))
			cursor += silenceDur
		}
	}

	if err := os.WriteFile(listPath, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		return 0, err
	}
	if err := audioprobe.ConcatAudio(listPath, outputPath, config.TtsVolumeGain); err != nil {
		return 0, err
	}
	finalDuration, err := audioprobe.ProbeDurationSecs(outputPath)
	if err != nil {
		return 0, err
	}

	timelineJSON, err := json.Marshal(timeline)
	if err != nil {
		return 0, err
	}
	if err := os.WriteFile(TimelinePathFor(outputPath), timelineJSON, 0o644); err != nil {
		return 0, err
	}
	return finalDuration, nil
}
