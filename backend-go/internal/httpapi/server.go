package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"time"

	"github.com/kevynsax/book-reader/backend-go/internal/config"
	"github.com/kevynsax/book-reader/backend-go/internal/queue"
	"github.com/kevynsax/book-reader/backend-go/internal/store"
	"github.com/kevynsax/book-reader/backend-go/internal/svc/tts"
	"github.com/kevynsax/book-reader/backend-go/internal/worker"
	"github.com/kevynsax/book-reader/backend-go/internal/ws"
)

type Server struct {
	St  *store.Store
	Hub *ws.Hub
	W   *worker.Worker
}

func New(st *store.Store, hub *ws.Hub, w *worker.Worker) http.Handler {
	s := &Server{St: st, Hub: hub, W: w}
	mux := http.NewServeMux()

	mux.Handle("/ws", hub)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		JSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/servers", s.handleServers)
	mux.HandleFunc("GET /api/models", s.handleModels)
	mux.HandleFunc("GET /api/models/{id}/voices", s.handleModelVoices)

	s.registerBookRoutes(mux)
	s.registerBookWriteRoutes(mux)
	s.registerLexiconRoutes(mux)

	return cors(mux)
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", config.FrontendOrigin)
		w.Header().Set("Vary", "Origin")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Available TTS servers with online state + active model, so the UI can show
// where generation will run. Sourced from the worker registry: each tts-role
// worker heartbeats its server's health/catalog, so main never probes.
func (s *Server) handleServers(w http.ResponseWriter, _ *http.Request) {
	workers := s.W.Q.Registry.Workers(queue.RoleTTS)
	sort.SliceStable(workers, func(i, j int) bool { return workers[i].ServerID < workers[j].ServerID })
	statuses := make([]tts.ServerStatus, len(workers))
	for i, hb := range workers {
		status := tts.ServerStatus{
			ID:     hb.ServerID,
			Label:  hb.Label,
			URL:    hb.URL,
			Online: hb.Healthy,
			Models: []tts.ModelRef{},
		}
		if hb.State != "" {
			state := hb.State
			status.State = &state
		}
		if hb.ActiveModel != "" {
			active := hb.ActiveModel
			status.ActiveModel = &active
		}
		if hb.Healthy {
			status.Error = (*string)(nil)
		}
		for _, m := range hb.Models {
			status.Models = append(status.Models, tts.ModelRef{ID: m.ID, Label: m.Label})
		}
		statuses[i] = status
	}
	JSON(w, http.StatusOK, statuses)
}

// Selectable TTS models — the union of what the servers advertise, falling
// back to the static catalog if all servers are offline.
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	servers := config.TtsServers
	catalogs := make([][]tts.CatalogModel, len(servers))
	done := make(chan int, len(servers))
	for i, srv := range servers {
		go func(i int, srv config.TtsServer) {
			catalogs[i] = tts.FetchCatalog(r.Context(), srv)
			done <- i
		}(i, srv)
	}
	for range servers {
		<-done
	}

	seen := map[string]bool{}
	out := []tts.ModelRef{}
	for _, list := range catalogs {
		for _, m := range list {
			if !seen[m.ID] {
				seen[m.ID] = true
				out = append(out, tts.ModelRef{ID: m.ID, Label: m.Label})
			}
		}
	}
	if len(out) == 0 {
		for _, m := range tts.Models {
			out = append(out, tts.ModelRef{ID: m.ID, Label: m.Label})
		}
	}
	JSON(w, http.StatusOK, out)
}

// Voices for a given model. A model is `available` if any server is online.
// For cloned-voice models the live voice list is read off any reachable
// server; named-voice models (Kokoro) use the catalog.
func (s *Server) handleModelVoices(w http.ResponseWriter, r *http.Request) {
	modelID := r.PathValue("id")
	servers := config.TtsServers
	statuses := make([]tts.ServerStatus, len(servers))
	done := make(chan int, len(servers))
	for i, srv := range servers {
		go func(i int, srv config.TtsServer) {
			statuses[i] = tts.Status(r.Context(), srv)
			done <- i
		}(i, srv)
	}
	for range servers {
		<-done
	}

	var online []tts.ServerStatus
	advertised := false
	for _, st := range statuses {
		if !st.Online {
			continue
		}
		online = append(online, st)
		for _, m := range st.Models {
			if m.ID == modelID {
				advertised = true
			}
		}
	}

	model, known := tts.GetModel(modelID)
	if !known {
		if !advertised {
			Error(w, http.StatusNotFound, "unknown model")
			return
		}
		model = tts.ClonedVoiceModel(modelID)
	}

	if len(online) == 0 {
		JSON(w, http.StatusOK, map[string]any{"available": false, "voices": []string{}})
		return
	}
	if model.Named {
		JSON(w, http.StatusOK, map[string]any{"available": true, "voices": model.FallbackVoices})
		return
	}

	// Prefer servers that actually advertise this model, and always ask for
	// THIS model's voices (?model=).
	hasModel := func(st tts.ServerStatus) bool {
		for _, m := range st.Models {
			if m.ID == modelID {
				return true
			}
		}
		return false
	}
	ordered := make([]tts.ServerStatus, 0, len(online))
	for _, st := range online {
		if hasModel(st) {
			ordered = append(ordered, st)
		}
	}
	for _, st := range online {
		if !hasModel(st) {
			ordered = append(ordered, st)
		}
	}

	for _, srv := range ordered {
		voices, names, ok := fetchVoices(r.Context(), srv.URL, modelID)
		if ok && len(voices) > 0 {
			resp := map[string]any{"available": true, "voices": voices}
			if names != nil {
				resp["names"] = names
			}
			JSON(w, http.StatusOK, resp)
			return
		}
	}
	JSON(w, http.StatusOK, map[string]any{"available": true, "voices": model.FallbackVoices})
}

func fetchVoices(ctx context.Context, serverURL, modelID string) ([]string, map[string]string, bool) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		serverURL+"/v1/audio/voices?model="+url.QueryEscape(modelID), nil)
	if err != nil {
		return nil, nil, false
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, nil, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, nil, false
	}
	var raw json.RawMessage
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, nil, false
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err == nil {
		return list, nil, true
	}
	var obj struct {
		Voices []string          `json:"voices"`
		Names  map[string]string `json:"names"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil && obj.Voices != nil {
		return obj.Voices, obj.Names, true
	}
	return nil, nil, false
}
