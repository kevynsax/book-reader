package tts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/kevynsax/book-reader/backend-go/internal/config"
)

type CatalogModel struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Repo   string `json:"repo,omitempty"`
	Active bool   `json:"active"`
}

// ModelRef is the trimmed {id,label} shape /api/servers and /api/models emit.
type ModelRef struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type ServerStatus struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	URL         string  `json:"url"`
	Online      bool    `json:"online"`
	State       *string `json:"state,omitempty"`
	ActiveModel *string `json:"activeModel,omitempty"`
	Backend     *string `json:"backend,omitempty"`
	// Present (possibly null) when the server is online, absent when offline —
	// matching Node's undefined-vs-null distinction.
	Error  any        `json:"error,omitempty"`
	Models []ModelRef `json:"models"`
}

const probeTimeout = 4 * time.Second

func getJSON(ctx context.Context, url string, timeout time.Duration, out any) bool {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return false
	}
	return json.NewDecoder(res.Body).Decode(out) == nil
}

// FetchCatalog lists the models a server advertises via /v1/models.
func FetchCatalog(ctx context.Context, server config.TtsServer) []CatalogModel {
	var data struct {
		Data []struct {
			ID     string `json:"id"`
			Label  string `json:"label"`
			Repo   string `json:"repo"`
			Active bool   `json:"active"`
		} `json:"data"`
	}
	if !getJSON(ctx, server.URL+"/v1/models", probeTimeout, &data) {
		return nil
	}
	var out []CatalogModel
	for _, m := range data.Data {
		if m.ID == "" {
			continue
		}
		label := m.Label
		if label == "" {
			label = m.ID
		}
		out = append(out, CatalogModel{ID: m.ID, Label: label, Repo: m.Repo, Active: m.Active})
	}
	return out
}

type Health struct {
	Online  bool
	State   string
	Model   string
	Backend string
	Error   *string
}

func FetchHealth(ctx context.Context, server config.TtsServer, timeout time.Duration) Health {
	var data struct {
		State   string  `json:"state"`
		Model   string  `json:"model"`
		Backend string  `json:"backend"`
		Error   *string `json:"error"`
	}
	if !getJSON(ctx, server.URL+"/health", timeout, &data) {
		return Health{Online: false}
	}
	return Health{Online: true, State: data.State, Model: data.Model, Backend: data.Backend, Error: data.Error}
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func Status(ctx context.Context, server config.TtsServer) ServerStatus {
	type result struct {
		health  Health
		catalog []CatalogModel
	}
	healthCh := make(chan Health, 1)
	catalogCh := make(chan []CatalogModel, 1)
	go func() { healthCh <- FetchHealth(ctx, server, probeTimeout) }()
	go func() { catalogCh <- FetchCatalog(ctx, server) }()
	r := result{health: <-healthCh, catalog: <-catalogCh}

	status := ServerStatus{
		ID:      server.ID,
		Label:   server.Label,
		URL:     server.URL,
		Online:  r.health.Online,
		State:   strPtr(r.health.State),
		Backend: strPtr(r.health.Backend),
		Models:  []ModelRef{},
	}
	if r.health.Online {
		status.Error = r.health.Error
	}
	for _, m := range r.catalog {
		if m.Active && status.ActiveModel == nil {
			id := m.ID
			status.ActiveModel = &id
		}
		status.Models = append(status.Models, ModelRef{ID: m.ID, Label: m.Label})
	}
	return status
}

// pollReady waits until the server reports `ready` with `modelID` active.
func pollReady(ctx context.Context, server config.TtsServer, modelID string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		health := FetchHealth(ctx, server, probeTimeout)
		if !health.Online || health.State == "error" {
			return false
		}
		if health.State == "ready" {
			for _, m := range FetchCatalog(ctx, server) {
				if m.Active && m.ID == modelID {
					return true
				}
			}
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(2 * time.Second):
		}
	}
	return false
}

// EnsureModelLoaded makes sure `modelID` is loaded and ready on this server,
// hot-swapping if needed. Returns false when the server is offline or the
// model fails to load.
func EnsureModelLoaded(ctx context.Context, server config.TtsServer, modelID string) bool {
	health := FetchHealth(ctx, server, probeTimeout)
	if !health.Online {
		return false
	}

	active := ""
	for _, m := range FetchCatalog(ctx, server) {
		if m.Active {
			active = m.ID
		}
	}
	if health.State == "ready" && active == modelID {
		return true
	}

	body, _ := json.Marshal(map[string]string{"model": modelID})
	loadCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(loadCtx, http.MethodPost, server.URL+"/v1/models/load", bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	res.Body.Close()
	// 409 == already loading (someone else asked); fall through to polling.
	if res.StatusCode >= 300 && res.StatusCode != http.StatusConflict {
		return false
	}
	return pollReady(ctx, server, modelID, 180*time.Second)
}

// PickReadyServer picks a single ready server for a one-off request.
func PickReadyServer(ctx context.Context, modelID string) (config.TtsServer, error) {
	for _, s := range config.TtsServers {
		if EnsureModelLoaded(ctx, s, modelID) {
			return s, nil
		}
	}
	return config.TtsServer{}, fmt.Errorf("no TTS server available for model %q", modelID)
}
