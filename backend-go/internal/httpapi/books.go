package httpapi

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/kevynsax/book-reader/backend-go/internal/config"
	"github.com/kevynsax/book-reader/backend-go/internal/model"
	"github.com/kevynsax/book-reader/backend-go/internal/svc/tts"
)

func (s *Server) registerBookRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/books/can-delete", s.handleCanDelete)
	mux.HandleFunc("PATCH /api/books/{id}", s.handleRename)
	mux.HandleFunc("DELETE /api/books/{id}", s.handleDelete)
	mux.HandleFunc("POST /api/books/{id}/dismiss-error", s.handleDismissError)
	mux.HandleFunc("GET /api/books/{id}/pages/{pageNum}", s.handlePageImage)
	mux.HandleFunc("GET /api/books/{id}/cover", s.handleCoverImage)
	mux.HandleFunc("GET /api/books/{id}/chapters/{chapterIdx}/audio", s.handleChapterAudio)
	mux.HandleFunc("GET /api/books/{id}/chapters/{chapterIdx}/timeline", s.handleChapterTimeline)
	mux.HandleFunc("GET /api/books/{id}/chapters/{idx}/sentences", s.handleSentences)
	mux.HandleFunc("GET /api/books/{id}/chapters/{idx}/sentences/{sentenceId}/audio", s.handleSentenceAudio)
}

func (s *Server) canDeleteBooks(r *http.Request) bool {
	if len(config.DeleteAllowedIPs) == 0 {
		return true
	}
	ip := ClientIP(r)
	for _, allowed := range config.DeleteAllowedIPs {
		if allowed == ip {
			return true
		}
	}
	return false
}

func (s *Server) handleCanDelete(w http.ResponseWriter, r *http.Request) {
	JSON(w, http.StatusOK, map[string]bool{"canDelete": s.canDeleteBooks(r)})
}

// findBook loads a book or writes the standard 404, mirroring Node's
// `if (!book) return res.status(404)...` prologue.
func (s *Server) findBook(w http.ResponseWriter, r *http.Request) *model.Book {
	book, err := s.St.Books.FindByID(r.Context(), r.PathValue("id"))
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return nil
	}
	if book == nil {
		Error(w, http.StatusNotFound, "Not found")
		return nil
	}
	return book
}

func (s *Server) handleRename(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(r, &body); err != nil || strings.TrimSpace(body.Name) == "" {
		Error(w, http.StatusBadRequest, "name is required")
		return
	}
	book.Name = strings.TrimSpace(body.Name)
	if err := s.St.Books.Save(r.Context(), book); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.Hub.Emit("book:update", map[string]any{
		"bookId": book.ID.Hex(), "updatedAt": book.UpdatedAt, "name": book.Name,
	})
	Message(w, "Renamed")
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	if !s.canDeleteBooks(r) {
		Error(w, http.StatusForbidden, "Deleting books is not allowed from this network")
		return
	}
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	book.Deleted = true
	if err := s.St.Books.Save(r.Context(), book); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.Hub.Emit("book:deleted", map[string]any{"bookId": r.PathValue("id")})
	Message(w, "Deleted")
}

// Discard the import error without retrying: clear the error message, accept
// any failed pages as-is, and move the book on to chapter review.
func (s *Server) handleDismissError(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	book.ErrorMessage = nil
	for i := range book.OcrPages {
		if book.OcrPages[i].Status == model.OcrErr {
			book.OcrPages[i].Status = model.OcrComplete
			book.OcrPages[i].Error = nil
		}
	}
	if book.Status == model.StatusError {
		book.Status = model.StatusAwaitingChapterReview
	}
	if err := s.St.Books.Save(r.Context(), book); err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.Hub.Emit("book:update", map[string]any{
		"bookId":       book.ID.Hex(),
		"updatedAt":    book.UpdatedAt,
		"status":       book.Status,
		"errorMessage": "",
		"ocrPages":     book.OcrPages,
	})
	Message(w, "Error dismissed.")
}

func (s *Server) handlePageImage(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	partsDir := filepath.Join(book.FolderPath, "parts")
	entries, err := os.ReadDir(partsDir)
	if err != nil {
		Error(w, http.StatusNotFound, "Pages not yet available")
		return
	}
	var jpgs []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".jpg") {
			jpgs = append(jpgs, e.Name())
		}
	}
	sort.Strings(jpgs)
	pageNum, _ := strconv.Atoi(r.PathValue("pageNum"))
	if pageNum < 1 || pageNum > len(jpgs) {
		Error(w, http.StatusNotFound, "Page not found")
		return
	}
	streamFile(w, filepath.Join(partsDir, jpgs[pageNum-1]), "image/jpeg", "")
}

func (s *Server) handleCoverImage(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	if book.CoverImagePath == nil || !fileExists(*book.CoverImagePath) {
		Error(w, http.StatusNotFound, "Cover not found")
		return
	}
	streamFile(w, *book.CoverImagePath, "image/jpeg", "no-cache")
}

// trackForVoice picks the requested (or primary) voice's track on a chapter.
func trackForVoice(book *model.Book, chapter *model.Chapter, voice string) (*model.VoiceTrack, string) {
	if voice == "" && len(book.Voices) > 0 {
		voice = book.Voices[0]
	}
	return book.TrackForVoice(chapter, voice), voice
}

func (s *Server) chapterFromPath(w http.ResponseWriter, r *http.Request, book *model.Book, param, missingMsg string) *model.Chapter {
	idx, err := strconv.Atoi(r.PathValue(param))
	if err != nil || idx < 0 || idx >= len(book.Chapters) {
		Error(w, http.StatusNotFound, missingMsg)
		return nil
	}
	return &book.Chapters[idx]
}

// Chapter MP3 with Range/206/ETag/304 — http.ServeContent supplies the Range
// and conditional-request handling the Node route hand-rolled.
func (s *Server) handleChapterAudio(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	chapter := s.chapterFromPath(w, r, book, "chapterIdx", "Not found")
	if chapter == nil {
		return
	}
	track, _ := trackForVoice(book, chapter, r.URL.Query().Get("voice"))
	if track == nil || track.AudioPath == nil || !fileExists(*track.AudioPath) {
		Error(w, http.StatusNotFound, "Audio not ready")
		return
	}

	f, err := os.Open(*track.AudioPath)
	if err != nil {
		Error(w, http.StatusNotFound, "Audio not ready")
		return
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Reassembly rewrites the file in place without changing its cache-buster,
	// so force revalidation: the ETag tracks size+mtime.
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", fmt.Sprintf(`"%d-%d"`, stat.Size(), stat.ModTime().UnixMilli()))
	http.ServeContent(w, r, "", stat.ModTime(), f)
}

func (s *Server) handleChapterTimeline(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	chapter := s.chapterFromPath(w, r, book, "chapterIdx", "Not found")
	if chapter == nil {
		return
	}
	track, _ := trackForVoice(book, chapter, r.URL.Query().Get("voice"))
	if track == nil || track.AudioPath == nil {
		Error(w, http.StatusNotFound, "No timeline")
		return
	}
	timelinePath := tts.TimelinePathFor(*track.AudioPath)
	if !fileExists(timelinePath) {
		Error(w, http.StatusNotFound, "No timeline")
		return
	}
	// Rewritten in place on every reassembly; never serve a stale copy.
	streamFile(w, timelinePath, "application/json", "no-store")
}

// Editable sentences for a chapter, with each sentence's per-segment status
// for the requested voice.
func (s *Server) handleSentences(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	chapter := s.chapterFromPath(w, r, book, "idx", "Chapter not found")
	if chapter == nil {
		return
	}
	track, voice := trackForVoice(book, chapter, r.URL.Query().Get("voice"))

	segBySentence := map[string]*model.Segment{}
	if track != nil {
		for i := range track.Segments {
			segBySentence[track.Segments[i].SentenceID.Hex()] = &track.Segments[i]
		}
	}

	ordered := append([]model.Sentence(nil), chapter.Sentences...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })

	type wireSentence struct {
		ID          string            `json:"_id"`
		Order       int               `json:"order"`
		Text        string            `json:"text"`
		Original    *string           `json:"original,omitempty"`
		AudioStatus model.AudioStatus `json:"audioStatus"`
		AudioError  *string           `json:"audioError,omitempty"`
	}
	sentences := make([]wireSentence, len(ordered))
	for i, sen := range ordered {
		out := wireSentence{
			ID: sen.ID.Hex(), Order: sen.Order, Text: sen.Text,
			Original: sen.Original, AudioStatus: model.AudioPending,
		}
		if seg := segBySentence[sen.ID.Hex()]; seg != nil {
			out.AudioStatus = seg.AudioStatus
			out.AudioError = seg.AudioError
		}
		sentences[i] = out
	}
	JSON(w, http.StatusOK, map[string]any{
		"voice": voice, "editable": len(sentences) > 0, "sentences": sentences,
	})
}

func (s *Server) handleSentenceAudio(w http.ResponseWriter, r *http.Request) {
	book := s.findBook(w, r)
	if book == nil {
		return
	}
	chapter := s.chapterFromPath(w, r, book, "idx", "Chapter not found")
	if chapter == nil {
		return
	}
	track, _ := trackForVoice(book, chapter, r.URL.Query().Get("voice"))
	if track == nil {
		Error(w, http.StatusNotFound, "No audio for this sentence")
		return
	}
	sentenceID := r.PathValue("sentenceId")
	for _, seg := range track.Segments {
		if seg.SentenceID.Hex() == sentenceID {
			if seg.AudioPath == nil || !fileExists(*seg.AudioPath) {
				break
			}
			streamFile(w, *seg.AudioPath, "audio/mpeg", "")
			return
		}
	}
	Error(w, http.StatusNotFound, "No audio for this sentence")
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func streamFile(w http.ResponseWriter, path, contentType, cacheControl string) {
	f, err := os.Open(path)
	if err != nil {
		Error(w, http.StatusNotFound, "Not found")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", contentType)
	if cacheControl != "" {
		w.Header().Set("Cache-Control", cacheControl)
	}
	if stat, err := f.Stat(); err == nil {
		w.Header().Set("Content-Length", strconv.FormatInt(stat.Size(), 10))
	}
	_, _ = ioCopy(w, f)
}
