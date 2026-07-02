package queue

import (
	"sync"
	"time"
)

// Registry is main's live view of the worker fleet, fed by heartbeats. An
// entry that hasn't beaten for expiry is treated as gone.
type Registry struct {
	mu      sync.Mutex
	entries map[string]entry // key: role|serverId
	expiry  time.Duration
}

type entry struct {
	hb   Heartbeat
	seen time.Time
}

func NewRegistry() *Registry {
	return &Registry{entries: map[string]entry{}, expiry: 15 * time.Second}
}

func (r *Registry) Update(hb Heartbeat) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries[string(hb.Role)+"|"+hb.ServerID] = entry{hb: hb, seen: time.Now()}
}

// Workers returns the live heartbeats for a role (all roles when role == "").
func (r *Registry) Workers(role Role) []Heartbeat {
	r.mu.Lock()
	defer r.mu.Unlock()
	cutoff := time.Now().Add(-r.expiry)
	var out []Heartbeat
	for _, e := range r.entries {
		if e.seen.Before(cutoff) {
			continue
		}
		if role != "" && e.hb.Role != role {
			continue
		}
		out = append(out, e.hb)
	}
	return out
}

// HasHealthy reports whether any live worker of the role has a healthy AI
// server — the fail-fast check that replaces per-call server probing.
func (r *Registry) HasHealthy(role Role) bool {
	for _, hb := range r.Workers(role) {
		if hb.Healthy {
			return true
		}
	}
	return false
}

// HasModelWorker reports whether any live healthy tts worker's server
// advertises the model — synthesis tasks for it would otherwise sit
// unclaimed until timeout.
func (r *Registry) HasModelWorker(model string) bool {
	for _, hb := range r.Workers(RoleTTS) {
		if !hb.Healthy {
			continue
		}
		for _, m := range hb.Models {
			if m.ID == model {
				return true
			}
		}
	}
	return false
}
