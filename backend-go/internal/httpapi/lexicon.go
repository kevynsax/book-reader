package httpapi

import (
	"net/http"
	"strings"

	"github.com/kevynsax/book-reader/backend-go/internal/model"
)

// InvalidateLexicon is wired to the normalizer's acronym cache once that
// service exists; kept as a hook so the PUT route invalidates read-time state.
var InvalidateLexicon = func(language string) {}

func (s *Server) registerLexiconRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/lexicon", func(w http.ResponseWriter, r *http.Request) {
		docs, err := s.St.Lexicons.All(r.Context())
		if err != nil {
			Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		if docs == nil {
			docs = []*model.Lexicon{}
		}
		JSON(w, http.StatusOK, docs)
	})

	mux.HandleFunc("GET /api/lexicon/{language}", func(w http.ResponseWriter, r *http.Request) {
		doc, err := s.St.Lexicons.ByLanguage(r.Context(), r.PathValue("language"))
		if err != nil {
			Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		if doc == nil {
			Error(w, http.StatusNotFound, "not found")
			return
		}
		JSON(w, http.StatusOK, doc)
	})

	mux.HandleFunc("PUT /api/lexicon/{language}", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Acronyms []struct {
				Term string `json:"term"`
				Say  string `json:"say"`
			} `json:"acronyms"`
		}
		if err := decodeJSON(r, &body); err != nil || body.Acronyms == nil {
			Error(w, http.StatusBadRequest, "acronyms must be an array")
			return
		}
		var acronyms []model.Acronym
		for _, a := range body.Acronyms {
			term, say := strings.TrimSpace(a.Term), strings.TrimSpace(a.Say)
			if term != "" && say != "" {
				acronyms = append(acronyms, model.Acronym{Term: term, Say: say})
			}
		}
		language := r.PathValue("language")
		doc, err := s.St.Lexicons.ReplaceAcronyms(r.Context(), language, acronyms)
		if err != nil {
			Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		InvalidateLexicon(language)
		JSON(w, http.StatusOK, doc)
	})
}
