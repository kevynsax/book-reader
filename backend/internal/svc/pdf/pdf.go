package pdf

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var pagesRe = regexp.MustCompile(`Pages:\s+(\d+)`)

func PageCount(pdfPath string) (int, error) {
	out, err := exec.Command("pdfinfo", pdfPath).Output()
	if err != nil {
		return 0, fmt.Errorf("pdfinfo not found. Install poppler: brew install poppler")
	}
	if m := pagesRe.FindSubmatch(out); m != nil {
		n, _ := strconv.Atoi(string(m[1]))
		return n, nil
	}
	return 0, nil
}

// SplitIntoPages rasterizes every page to JPEG at 150 DPI under
// outputDir/parts and returns the page count.
func SplitIntoPages(pdfPath, outputDir string) (int, error) {
	partsDir := filepath.Join(outputDir, "parts")
	if err := os.MkdirAll(partsDir, 0o755); err != nil {
		return 0, err
	}
	numPages, err := PageCount(pdfPath)
	if err != nil {
		return 0, err
	}
	cmd := exec.Command("pdftoppm",
		"-jpeg", "-r", "150", "-jpegopt", "quality=85",
		pdfPath, filepath.Join(partsDir, "page"))
	if err := cmd.Run(); err != nil {
		return 0, fmt.Errorf("pdftoppm not found. Install poppler: brew install poppler")
	}
	return numPages, nil
}

func pageImages(outputDir string) ([]string, error) {
	partsDir := filepath.Join(outputDir, "parts")
	entries, err := os.ReadDir(partsDir)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, "page-") && strings.HasSuffix(name, ".jpg") {
			files = append(files, name)
		}
	}
	sort.Strings(files)
	paths := make([]string, len(files))
	for i, f := range files {
		paths[i] = filepath.Join(partsDir, f)
	}
	return paths, nil
}

// FindPageImagePath resolves the 1-based page number to its rasterized image,
// or "" when unavailable.
func FindPageImagePath(outputDir string, pageNum int) string {
	paths, err := pageImages(outputDir)
	if err != nil || pageNum < 1 || pageNum > len(paths) {
		return ""
	}
	return paths[pageNum-1]
}

func AllPagePaths(outputDir string) ([]string, error) {
	return pageImages(outputDir)
}

func ReadPageAsBase64(imagePath string) (string, error) {
	data, err := os.ReadFile(imagePath)
	if err != nil {
		return "", err
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data), nil
}

func CopyPageAsCover(imagePath, coverPath string) error {
	data, err := os.ReadFile(imagePath)
	if err != nil {
		return err
	}
	return os.WriteFile(coverPath, data, 0o644)
}
