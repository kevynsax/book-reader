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
// verify/split recursion. Which TTS worker renders each chunk is the queue's
// concern — whichever healthy one is free claims it.
type renderContext struct {
	q        *queue.Client
	model    Model
	voice    string
	speed    float64
	language string
}

// renderChunkToBuffer synthesizes one chunk via the tts task queue, retrying
// transient failures so a single dropped request doesn't fail the chapter.
func renderChunkToBuffer(ctx context.Context, text string, rc renderContext) (chunkResult, error) {
	var lastErr error
	for attempt := 0; attempt <= chunkRetries; attempt++ {
		res, err := rc.q.Synthesize(ctx, queue.SynthesizePayload{
			Model:        rc.model.ID,
			Input:        text,
			Voice:        rc.voice,
			Speed:        rc.speed,
			Language:     rc.language,
			UsesLanguage: rc.model.UsesLanguage,
		})
		if err == nil {
			return chunkResult{buffer: res.Audio, durationSecs: res.DurationSecs}, nil
		}
		lastErr = err
	}
	return chunkResult{}, lastErr
}

// concatBuffers joins rendered mp3 buffers into one (PCM-domain concat +
// re-encode), no gain — chapter assembly applies the volume boost later.
func concatBuffers(buffers [][]byte) ([]byte, error) {
	if len(buffers) == 1 {
		return buffers[0], nil
	}
	dir, err := os.MkdirTemp("", "segpieces-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	var lines []string
	for i, buf := range buffers {
		f := filepath.Join(dir, fmt.Sprintf("p%03d.mp3", i))
		if err := os.WriteFile(f, buf, 0o644); err != nil {
			return nil, err
		}
		lines = append(lines, concatLine(f))
	}
	listPath := filepath.Join(dir, "list.txt")
	if err := os.WriteFile(listPath, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		return nil, err
	}
	outPath := filepath.Join(dir, "out.mp3")
	if err := audioprobe.ConcatAudio(listPath, outPath, 1); err != nil {
		return nil, err
	}
	return os.ReadFile(outPath)
}

// SlmSplitInTwo asks the SLM (gemma) — via an slm-role task — to divide the
// ORIGINAL (un-normalized) sentence text into two complete sub-sentences.
// Splitting the original — not the speech-expanded text — keeps each piece's
// on-screen display clean. Returns nil when the model declines or errors.
func SlmSplitInTwo(ctx context.Context, q *queue.Client, display string) []string {
	sug, err := q.SplitInTwo(ctx, display, config.SlmSplitModel)
	if err != nil {
		log.Printf("SLM split failed: %v", err)
		return nil
	}
	if sug.Left != "" && sug.Right != "" {
		return []string{sug.Left, sug.Right}
	}
	return nil
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
	return parts
}

// RenderedPiece is one verified leaf of a sentence: the original display
// text, the speech-ready text actually synthesized, and the audio confirmed
// (within tolerance) to say it. Transcripts traces verification quality —
// every transcript Whisper returned on the way to this audio, in attempt
// order (a piece that inherited a split also carries its parent's failed
// transcripts first).
type RenderedPiece struct {
	Display      string
	Text         string
	Buffer       []byte
	DurationSecs float64
	Transcripts  []string
}

// renderVerifiedPieces renders a chunk and confirms — via Whisper — that it
// says what was asked. On a low-similarity transcript an SLM judge decides
// whether the audio actually LOST content or merely differs in benign ways
// (spelled-out numbers, mis-heard names): benign → the audio is accepted;
// missing content → re-synthesize up to TtsVerifyAttempts times and only
// then ask the SLM to split the original `display` text. Returns the flat
// list of verified leaves (length 1 when it rendered cleanly, can't be
// split, or hit the depth cap — best attempt kept).
func renderVerifiedPieces(ctx context.Context, display, text string, rc renderContext, depth int, parentTranscripts []string) ([]RenderedPiece, error) {
	transcripts := append([]string(nil), parentTranscripts...)

	var best RenderedPiece
	bestSimilarity := -1.0
	for attempt := 1; attempt <= config.TtsVerifyAttempts; attempt++ {
		result, err := renderChunkToBuffer(ctx, text, rc)
		if err != nil {
			return nil, err
		}
		leaf := RenderedPiece{Display: display, Text: text, Buffer: result.buffer, DurationSecs: result.durationSecs}

		if !config.TtsVerify || len(strings.TrimSpace(text)) < config.TtsVerifyMinChars {
			leaf.Transcripts = transcripts
			return []RenderedPiece{leaf}, nil
		}

		transcript, err := rc.q.Transcribe(ctx, result.buffer, rc.language)
		if err != nil {
			// ASR unavailable (no whisper worker / timeout) — don't block.
			log.Printf("tts verify: transcription unavailable: %v", err)
			leaf.Transcripts = transcripts
			return []RenderedPiece{leaf}, nil
		}
		transcripts = append(transcripts, transcript)
		leaf.Transcripts = transcripts

		similarity := verify.WordSimilarityLang(text, transcript, rc.language)
		if similarity >= config.TtsVerifyThreshold {
			return []RenderedPiece{leaf}, nil
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
			return []RenderedPiece{leaf}, nil
		} else {
			log.Printf("tts verify: attempt %d/%d missing content (sim=%.2f, %s) for %q",
				attempt, config.TtsVerifyAttempts, similarity, truncate(verdict.Reason, 80), truncate(display, 60))
		}
	}
	best.Transcripts = transcripts

	if depth >= config.TtsVerifyMaxDepth {
		log.Printf("tts verify: keeping best after %d splits (sim=%.2f) for %q", depth, bestSimilarity, truncate(display, 60))
		return []RenderedPiece{best}, nil
	}

	parts := SlmSplitInTwo(ctx, rc.q, display)
	if parts == nil {
		log.Printf("tts verify: unsplittable mismatch (sim=%.2f) for %q", bestSimilarity, truncate(display, 60))
		return []RenderedPiece{best}, nil
	}

	var pieces []RenderedPiece
	for i, part := range parts {
		speakable := strings.TrimSpace(normalizer.NormalizeForSpeech(ctx, part, rc.language))
		if speakable == "" {
			speakable = part
		}
		// The first piece inherits the parent's failed transcripts so the
		// full story of why this sentence split stays on one record.
		inherited := []string(nil)
		if i == 0 {
			inherited = transcripts
		}
		sub, err := renderVerifiedPieces(ctx, part, speakable, rc, depth+1, inherited)
		if err != nil {
			return nil, err
		}
		pieces = append(pieces, sub...)
	}
	return pieces, nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// RenderSegmentPieces verifies a sentence and returns the leaf pieces it
// broke down into (one entry when nothing needed splitting).
func RenderSegmentPieces(ctx context.Context, q *queue.Client, display, text, voice, language string) ([]RenderedPiece, error) {
	model, bareVoice := ParseVoice(voice)
	speakable := strings.TrimSpace(text)
	if speakable == "" {
		return nil, fmt.Errorf("empty sentence")
	}
	d := strings.TrimSpace(display)
	if d == "" {
		d = speakable
	}
	return renderVerifiedPieces(ctx, d, speakable,
		renderContext{q: q, model: model, voice: bareVoice, speed: config.TtsSpeed, language: language}, 0, nil)
}

// SynthesizeSegment renders one sentence to its own mp3 file, verifying it
// against Whisper. On a mismatch the verified pieces are stitched back into a
// single segment (used by the single-sentence edit/regenerate path). Returns
// the duration plus every transcript observed while producing the audio.
func SynthesizeSegment(ctx context.Context, q *queue.Client, text, outputPath, voice, language string) (float64, []string, error) {
	pieces, err := RenderSegmentPieces(ctx, q, text, text, voice, language)
	if err != nil {
		return 0, nil, err
	}
	buffers := make([][]byte, len(pieces))
	var transcripts []string
	for i, p := range pieces {
		buffers[i] = p.Buffer
		transcripts = append(transcripts, p.Transcripts...)
	}
	buffer, err := concatBuffers(buffers)
	if err != nil {
		return 0, nil, err
	}
	durationSecs := pieces[0].DurationSecs
	if len(pieces) > 1 {
		if durationSecs, err = audioprobe.ProbeMp3Buffer(buffer); err != nil {
			return 0, nil, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return 0, nil, err
	}
	if err := os.WriteFile(outputPath, buffer, 0o644); err != nil {
		return 0, nil, err
	}
	return durationSecs, transcripts, nil
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
