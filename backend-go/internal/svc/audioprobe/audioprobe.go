package audioprobe

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

func run(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			return "", fmt.Errorf("%s: %s", name, strings.TrimSpace(string(ee.Stderr)))
		}
		return "", err
	}
	return string(out), nil
}

func tmpFile(prefix string) string {
	f, err := os.CreateTemp("", prefix+"*.mp3")
	if err != nil {
		return filepath.Join(os.TempDir(), prefix+strconv.Itoa(os.Getpid())+".mp3")
	}
	name := f.Name()
	f.Close()
	return name
}

// ConcatAudio concatenates the audio files listed in a concat-demuxer manifest
// into one mp3, optionally scaling volume. Always decodes and re-encodes: raw
// mp3 byte-concat drops ~20ms at every segment boundary, which desyncs the
// read-along timeline; decoding to PCM first makes the join sample-accurate.
func ConcatAudio(listPath, output string, volume float64) error {
	args := []string{"-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listPath}
	if volume != 1 {
		args = append(args, "-filter:a", fmt.Sprintf("volume=%g", volume))
	}
	args = append(args, "-c:a", "libmp3lame", "-q:a", "2", "-write_xing", "1", output)
	_, err := run("ffmpeg", args...)
	return err
}

// ApplyVolume re-encodes an in-memory mp3 with a volume scale (used to boost
// title segments before chapter concat).
func ApplyVolume(buffer []byte, volume float64) ([]byte, error) {
	if volume == 1 {
		return buffer, nil
	}
	inPath := tmpFile("vol_in_")
	outPath := tmpFile("vol_out_")
	defer os.Remove(inPath)
	defer os.Remove(outPath)
	if err := os.WriteFile(inPath, buffer, 0o644); err != nil {
		return nil, err
	}
	if _, err := run("ffmpeg",
		"-y", "-v", "error", "-i", inPath,
		"-filter:a", fmt.Sprintf("volume=%g", volume), "-c:a", "libmp3lame", "-q:a", "2",
		outPath); err != nil {
		return nil, err
	}
	return os.ReadFile(outPath)
}

// ProbeAudioFormat reports sample rate and channel count of a file's first
// audio stream, so generated silence matches the TTS segments around it.
func ProbeAudioFormat(file string) (sampleRate, channels int, err error) {
	out, err := run("ffprobe",
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=sample_rate,channels",
		"-of", "default=noprint_wrappers=1",
		file)
	if err != nil {
		return 0, 0, err
	}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		key, value, _ := strings.Cut(line, "=")
		switch key {
		case "sample_rate":
			sampleRate, _ = strconv.Atoi(value)
		case "channels":
			channels, _ = strconv.Atoi(value)
		}
	}
	if sampleRate == 0 {
		sampleRate = 24000
	}
	if channels == 0 {
		channels = 1
	}
	return sampleRate, channels, nil
}

// GenerateSilence renders an mp3 of pure silence, format-matched so it can be
// concatenated with TTS segments before the final re-encode.
func GenerateSilence(durationSecs float64, sampleRate, channels int) ([]byte, error) {
	tmp := tmpFile("silence_")
	defer os.Remove(tmp)
	layout := "stereo"
	if channels == 1 {
		layout = "mono"
	}
	if _, err := run("ffmpeg",
		"-y", "-v", "error",
		"-f", "lavfi",
		"-i", fmt.Sprintf("anullsrc=r=%d:cl=%s", sampleRate, layout),
		"-t", strconv.FormatFloat(durationSecs, 'f', -1, 64),
		"-c:a", "libmp3lame", "-q:a", "2",
		tmp); err != nil {
		return nil, err
	}
	return os.ReadFile(tmp)
}

var outTimeRe = regexp.MustCompile(`out_time_us=(\d+)|out_time_ms=(\d+)`)

// DecodedDurationSecs is the true decoded duration in seconds: the number of
// samples the decoder actually emits, which is what concat and playback use.
// Differs from format=duration for files carrying a LAME/Xing gapless tag.
// Summed decoded durations equal the concat output exactly, so the read-along
// timeline stays locked to the audio.
func DecodedDurationSecs(file string) (float64, error) {
	out, err := run("ffmpeg", "-v", "error", "-i", file, "-f", "null", "-progress", "pipe:1", "-")
	if err != nil {
		return 0, err
	}
	matches := outTimeRe.FindAllString(out, -1)
	if len(matches) == 0 {
		return 0, fmt.Errorf("ffmpeg returned no duration for %s", file)
	}
	_, val, _ := strings.Cut(matches[len(matches)-1], "=")
	us, err := strconv.ParseInt(val, 10, 64)
	if err != nil || us <= 0 {
		return 0, fmt.Errorf("ffmpeg returned no duration for %s", file)
	}
	return float64(us) / 1e6, nil
}

func ProbeDurationSecs(file string) (float64, error) {
	out, err := run("ffprobe",
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		file)
	if err != nil {
		return 0, err
	}
	secs, err := strconv.ParseFloat(strings.TrimSpace(out), 64)
	if err != nil || secs <= 0 {
		return 0, fmt.Errorf("ffprobe returned no duration for %s", file)
	}
	return secs, nil
}

// ProbeMp3Buffer measures the duration of an in-memory mp3 (for engines that
// don't return a duration header).
func ProbeMp3Buffer(buffer []byte) (float64, error) {
	tmp := tmpFile("probe_")
	defer os.Remove(tmp)
	if err := os.WriteFile(tmp, buffer, 0o644); err != nil {
		return 0, err
	}
	return ProbeDurationSecs(tmp)
}
