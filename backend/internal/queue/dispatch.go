package queue

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// The TTS dispatcher: every synthesize render first acquires one specific
// free server, then publishes to that server's private queue. Priority is the
// render's position in the book's global work order (voices by insertion,
// chapters in order), so when a server frees up it always helps the earliest
// voice/chapter it is able to render — the whole fleet walks the same order,
// and a server that can't serve the current voice's model works ahead on the
// next one it can.

const (
	dispatchTick = 2 * time.Second
	// A render whose model no live server advertises fails after this grace
	// (long enough to ride out a server restart), so a chapter errors out
	// instead of blocking its run forever.
	noServerGrace = 90 * time.Second
	// An in-flight render is abandoned once its server has been gone or
	// unhealthy for this long (servers scale down at any time; the segment
	// then retries on whichever server the dispatcher grants next). Long
	// enough to ride out the registry's 15s heartbeat expiry plus probe
	// flakiness, far shorter than the 300s RPC timeout.
	liveProbeEvery  = 5 * time.Second
	liveProbeMisses = 6
)

type ttsGrant struct {
	serverID string
	err      error
}

type ttsWaiter struct {
	priority int64
	seq      uint64
	model    string
	// lastAdvertised is the last time any live server advertised the model
	// (starts at creation); the no-server grace counts from here, so a model
	// whose servers scale away mid-wait still gets the full grace.
	lastAdvertised time.Time
	grant          chan ttsGrant
}

// AcquireTTS blocks until a healthy tts server advertising the model is free,
// then reserves it. Waiters are served lowest priority first (FIFO within a
// priority). The release func frees the server for the next waiter; call it
// as soon as the synthesize RPC returns.
func (c *Client) AcquireTTS(ctx context.Context, priority int64, modelID string) (string, func(), error) {
	w := &ttsWaiter{priority: priority, model: modelID, lastAdvertised: time.Now(), grant: make(chan ttsGrant, 1)}
	c.dmu.Lock()
	c.waiterSeq++
	w.seq = c.waiterSeq
	c.waiters = append(c.waiters, w)
	c.dmu.Unlock()
	c.dispatch()

	select {
	case g := <-w.grant:
		if g.err != nil {
			return "", nil, g.err
		}
		var once sync.Once
		release := func() { once.Do(func() { c.releaseTTS(g.serverID) }) }
		return g.serverID, release, nil
	case <-ctx.Done():
		c.dmu.Lock()
		removed := false
		for i, other := range c.waiters {
			if other == w {
				c.waiters = append(c.waiters[:i], c.waiters[i+1:]...)
				removed = true
				break
			}
		}
		c.dmu.Unlock()
		if !removed {
			// dispatch granted concurrently with the cancellation; give the
			// server back.
			if g := <-w.grant; g.err == nil {
				c.releaseTTS(g.serverID)
			}
		}
		return "", nil, ctx.Err()
	}
}

// serverLive reports whether the server still heartbeats healthy.
func (c *Client) serverLive(serverID string) bool {
	for _, hb := range c.Registry.Workers(RoleTTS) {
		if hb.ServerID == serverID {
			return hb.Healthy
		}
	}
	return false
}

// watchServer cancels the returned context once serverID stops heartbeating
// healthy for liveProbeMisses consecutive probes. Callers must call the
// returned stop func when the guarded call finishes.
func (c *Client) watchServer(ctx context.Context, serverID string) (context.Context, func()) {
	wctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		misses := 0
		ticker := time.NewTicker(liveProbeEvery)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if c.serverLive(serverID) {
					misses = 0
					continue
				}
				if misses++; misses >= liveProbeMisses {
					cancel()
					return
				}
			}
		}
	}()
	var once sync.Once
	return wctx, func() {
		once.Do(func() {
			close(done)
			cancel()
		})
	}
}

func (c *Client) releaseTTS(serverID string) {
	c.dmu.Lock()
	delete(c.inflight, serverID)
	c.dmu.Unlock()
	c.dispatch()
}

// dispatchLoop re-runs matching on a slow tick so waiters pick up servers
// that turned healthy (or vanished) between acquire/release events.
func (c *Client) dispatchLoop() {
	ticker := time.NewTicker(dispatchTick)
	defer ticker.Stop()
	for range ticker.C {
		c.mu.Lock()
		closed := c.closed
		c.mu.Unlock()
		if closed {
			return
		}
		c.dispatch()
	}
}

// dispatch matches waiting renders to free servers, earliest waiter first. A
// free server that already has the waiter's model loaded is preferred, so
// granting never forces a hot-swap another free server would avoid.
func (c *Client) dispatch() {
	c.dmu.Lock()
	defer c.dmu.Unlock()
	if len(c.waiters) == 0 {
		return
	}

	type server struct {
		id          string
		activeModel string
		models      map[string]bool
	}
	var free []*server
	advertised := map[string]bool{}
	for _, hb := range c.Registry.Workers(RoleTTS) {
		if !hb.Healthy {
			continue
		}
		models := map[string]bool{}
		for _, m := range hb.Models {
			models[m.ID] = true
			advertised[m.ID] = true
		}
		if _, busy := c.inflight[hb.ServerID]; !busy {
			free = append(free, &server{id: hb.ServerID, activeModel: hb.ActiveModel, models: models})
		}
	}

	sort.SliceStable(c.waiters, func(i, j int) bool {
		if c.waiters[i].priority != c.waiters[j].priority {
			return c.waiters[i].priority < c.waiters[j].priority
		}
		return c.waiters[i].seq < c.waiters[j].seq
	})

	now := time.Now()
	var remaining []*ttsWaiter
	for _, w := range c.waiters {
		if advertised[w.model] {
			w.lastAdvertised = now
		}
		var pick int = -1
		for i, s := range free {
			if !s.models[w.model] {
				continue
			}
			if pick < 0 {
				pick = i
			}
			if s.activeModel == w.model {
				pick = i
				break
			}
		}
		switch {
		case pick >= 0:
			s := free[pick]
			free = append(free[:pick], free[pick+1:]...)
			c.inflight[s.id] = w.model
			w.grant <- ttsGrant{serverID: s.id}
		case !advertised[w.model] && now.Sub(w.lastAdvertised) > noServerGrace:
			w.grant <- ttsGrant{err: fmt.Errorf("no TTS server is online for model %q", w.model)}
		default:
			remaining = append(remaining, w)
		}
	}
	c.waiters = remaining
}
