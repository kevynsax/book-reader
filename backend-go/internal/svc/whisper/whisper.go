// Package whisper transcribes synthesized audio via an OpenAI-compatible
// /v1/audio/transcriptions server. Balancing and fallback live in the task
// queue now: each whisper-role worker owns exactly one server.
package whisper

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"github.com/kevynsax/book-reader/backend-go/internal/config"
)

// TranscribeOn transcribes an mp3 buffer against exactly one whisper server.
func TranscribeOn(ctx context.Context, base string, audio []byte, language string) (string, error) {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", "segment.mp3")
	if err != nil {
		return "", err
	}
	if _, err := part.Write(audio); err != nil {
		return "", err
	}
	_ = form.WriteField("model", config.WhisperModel)
	_ = form.WriteField("response_format", "json")
	if language != "" {
		_ = form.WriteField("language", language)
	}
	if err := form.Close(); err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, time.Duration(config.WhisperTimeoutMs)*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/audio/transcriptions", &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		msg := strings.TrimSpace(string(raw))
		if msg == "" {
			msg = fmt.Sprintf("Whisper API returned %d", res.StatusCode)
		}
		return "", fmt.Errorf("%s", msg)
	}
	var data struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", err
	}
	return strings.TrimSpace(data.Text), nil
}
