// worker is a role executor: it owns exactly one AI server (TTS / QwenVL /
// SLM / Whisper), heartbeats its health every cycle, and — while healthy —
// consumes tasks for its role one at a time (prefetch=1, a serial AI server
// is never over-committed). After finishing a task it immediately takes the
// next; when the queue is idle it just keeps the health loop. There is no
// fallback logic anywhere: an unacked task from a dead worker is redelivered
// by the broker to another worker of the same role.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/kevynsax/book-reader/backend/internal/config"
	"github.com/kevynsax/book-reader/backend/internal/queue"
	"github.com/kevynsax/book-reader/backend/internal/svc/ocr"
	"github.com/kevynsax/book-reader/backend/internal/svc/tts"
	"github.com/kevynsax/book-reader/backend/internal/svc/whisper"
)

type worker struct {
	role     queue.Role
	serverID string
	label    string
	url      string
	model    string // vlm only: the backend's own model name

	busy    atomic.Bool
	healthy atomic.Bool

	mu   sync.Mutex
	conn *amqp.Connection
	ch   *amqp.Channel
	// consumers maps queue name -> consumer tag. Non-tts roles consume one
	// role queue; a tts worker consumes one queue per model its server
	// advertises (tasks.tts.<model>) so it can never claim a synthesis task
	// for a model it can't run. Qos(1) is channel-wide, so the worker still
	// executes one task at a time across all its queues.
	consumers map[string]string

	// Soft model affinity: while this tts worker is "hot" on a model (a
	// synthesize task for it ran recently), it consumes ONLY that model's
	// queue. Render lanes for different models then split cleanly across
	// servers instead of one multi-model server hot-swapping on every task.
	// Goes cold after affinityWindow with no task, re-subscribing to all.
	//
	// Exception (starvation guard): a queue whose model has NO other healthy
	// provider is never dropped — if this worker is the only server that can
	// render a model, going hot on something else would stall that model's
	// lane indefinitely. peers tracks the other tts workers' heartbeats.
	affModel string
	affAt    time.Time
	peers    map[string]peerState
}

type peerState struct {
	models map[string]bool
	seen   time.Time
}

// affinityWindow must comfortably exceed the gap between two synthesize tasks
// of an active lane — each segment goes synth → whisper transcribe → SLM
// judge (→ retries) before the next synth task lands, easily 30s+. A window
// shorter than that makes the worker go cold mid-lane and grab another
// model's task, paying two hot-swaps per lapse.
const (
	affinityWindow = 120 * time.Second
	// How long a peer's last healthy heartbeat keeps counting it as a
	// provider. Generous on purpose: a GPU busy with a long render can miss
	// health probes for a few cycles, and treating that flap as "the peer is
	// gone" makes this worker take over the peer's queue and hot-swap-thrash.
	// A truly dead server still fails over in ~a minute.
	peerExpiry = 75 * time.Second
)

// watchPeers consumes the heartbeat fanout (own channel — the task channel's
// Qos(1) must not throttle it) and keeps a live map of which models the other
// healthy tts workers can serve.
func (w *worker) watchPeers(conn *amqp.Connection) error {
	ch, err := conn.Channel()
	if err != nil {
		return err
	}
	q, err := ch.QueueDeclare("", false, true, true, false, nil)
	if err != nil {
		return err
	}
	if err := ch.QueueBind(q.Name, "", queue.HeartbeatQueue, false, nil); err != nil {
		return err
	}
	beats, err := ch.Consume(q.Name, "", true, true, false, false, nil)
	if err != nil {
		return err
	}
	go func() {
		for d := range beats {
			var hb queue.Heartbeat
			if err := json.Unmarshal(d.Body, &hb); err != nil {
				continue
			}
			if hb.Role != queue.RoleTTS || hb.ServerID == w.serverID || !hb.Healthy {
				continue
			}
			models := map[string]bool{}
			for _, m := range hb.Models {
				models[m.ID] = true
			}
			w.mu.Lock()
			if w.peers == nil {
				w.peers = map[string]peerState{}
			}
			w.peers[hb.ServerID] = peerState{models: models, seen: time.Now()}
			w.mu.Unlock()
		}
	}()
	return nil
}

// hasOtherProvider reports whether any other live tts worker advertises the
// model. Must be called with w.mu held.
func (w *worker) hasOtherProviderLocked(model string) bool {
	for id, p := range w.peers {
		if time.Since(p.seen) > peerExpiry {
			delete(w.peers, id)
			continue
		}
		if p.models[model] {
			return true
		}
	}
	return false
}

func (w *worker) touchAffinity(model string) {
	w.mu.Lock()
	w.affModel, w.affAt = model, time.Now()
	w.mu.Unlock()
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	// Workers reuse the svc code, which reads tunables (whisper model/timeout,
	// prompts) from config.
	config.Load()

	w := &worker{
		role:     queue.Role(os.Getenv("WORKER_ROLE")),
		serverID: os.Getenv("WORKER_SERVER_ID"),
		label:    os.Getenv("WORKER_SERVER_LABEL"),
		url:      os.Getenv("WORKER_SERVER_URL"),
		model:    os.Getenv("WORKER_SERVER_MODEL"),
	}
	valid := false
	for _, r := range queue.Roles {
		if w.role == r {
			valid = true
		}
	}
	if !valid || w.serverID == "" || w.url == "" {
		log.Fatal("worker needs WORKER_ROLE (tts|vlm|slm|whisper), WORKER_SERVER_ID and WORKER_SERVER_URL")
	}
	if w.label == "" {
		w.label = w.serverID
	}
	amqpURL := env("AMQP_URL", "amqp://guest:guest@localhost:5672/")
	healthMs, _ := strconv.Atoi(env("WORKER_HEALTH_MS", "5000"))
	if healthMs <= 0 {
		healthMs = 5000
	}

	log.Printf("worker %s/%s starting (server %s)", w.role, w.serverID, w.url)
	for {
		if err := w.run(amqpURL, time.Duration(healthMs)*time.Millisecond); err != nil {
			log.Printf("worker: %v (reconnecting in 5s)", err)
		}
		time.Sleep(5 * time.Second)
	}
}

// run owns one AMQP connection: the health/heartbeat loop starts and stops
// the task consumer as the AI server comes and goes.
func (w *worker) run(amqpURL string, healthEvery time.Duration) error {
	conn, err := amqp.Dial(amqpURL)
	if err != nil {
		return fmt.Errorf("amqp dial: %w", err)
	}
	defer conn.Close()
	ch, err := conn.Channel()
	if err != nil {
		return err
	}
	if err := queue.DeclareTopology(ch); err != nil {
		return err
	}
	if err := ch.Qos(1, 0, false); err != nil {
		return err
	}
	w.mu.Lock()
	w.conn, w.ch = conn, ch
	w.consumers = map[string]string{}
	w.mu.Unlock()

	if w.role == queue.RoleTTS {
		if err := w.watchPeers(conn); err != nil {
			return fmt.Errorf("peer watch: %w", err)
		}
	}

	closed := make(chan *amqp.Error, 1)
	conn.NotifyClose(closed)

	ticker := time.NewTicker(healthEvery)
	defer ticker.Stop()

	w.healthCycle() // immediate first probe, then every tick
	for {
		select {
		case err := <-closed:
			return fmt.Errorf("connection lost: %v", err)
		case <-ticker.C:
			w.healthCycle()
		}
	}
}

func (w *worker) healthCycle() {
	hb := w.probe()
	w.healthy.Store(hb.Healthy)
	hb.Busy = w.busy.Load()

	w.mu.Lock()
	ch := w.ch
	w.mu.Unlock()
	if ch == nil {
		return
	}

	body, _ := json.Marshal(hb)
	_ = ch.Publish(queue.HeartbeatQueue, "", false, false, amqp.Publishing{
		ContentType: "application/json",
		Body:        body,
	})

	// The queues this worker should be consuming right now: nothing while
	// unhealthy; the role queue for vlm/slm/whisper; one queue per advertised
	// model for tts (capability routing) — narrowed to the hot model while
	// affinity holds, EXCEPT models only this worker can serve: those queues
	// stay subscribed always, so being hot on a shared model can never starve
	// a sole-provider model's lane.
	desired := map[string]bool{}
	if hb.Healthy {
		if w.role == queue.RoleTTS {
			w.mu.Lock()
			hot := w.affModel
			if hot != "" && time.Since(w.affAt) > affinityWindow {
				hot, w.affModel = "", ""
			}
			hotAdvertised := false
			for _, m := range hb.Models {
				if m.ID == hot {
					hotAdvertised = true
				}
			}
			for _, m := range hb.Models {
				soleProvider := !w.hasOtherProviderLocked(m.ID)
				if hot == "" || !hotAdvertised || m.ID == hot || soleProvider {
					desired[queue.TTSTaskQueue(m.ID)] = true
				}
			}
			w.mu.Unlock()
		} else {
			desired[queue.TaskQueueName(w.role)] = true
		}
	}
	w.reconcileConsumers(desired)
}

// reconcileConsumers starts consumers for newly-desired queues and cancels
// ones no longer desired (server unhealthy, or a model left the catalog).
func (w *worker) reconcileConsumers(desired map[string]bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ch == nil {
		return
	}
	for queueName, tag := range w.consumers {
		if !desired[queueName] {
			_ = w.ch.Cancel(tag, false)
			delete(w.consumers, queueName)
			log.Printf("worker: stopped consuming %s", queueName)
		}
	}
	for queueName := range desired {
		if _, ok := w.consumers[queueName]; ok {
			continue
		}
		if err := w.startConsumerLocked(queueName); err != nil {
			log.Printf("worker: start consumer %s: %v", queueName, err)
		} else {
			log.Printf("worker: %s healthy — consuming %s", w.url, queueName)
		}
	}
}

// probe checks the AI server and builds this cycle's heartbeat.
func (w *worker) probe() queue.Heartbeat {
	hb := queue.Heartbeat{
		Role: w.role, ServerID: w.serverID, Label: w.label, URL: w.url,
		Models: []queue.Model{},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	switch w.role {
	case queue.RoleTTS:
		server := config.TtsServer{ID: w.serverID, Label: w.label, URL: w.url}
		health := tts.FetchHealth(ctx, server, 4*time.Second)
		hb.Healthy = health.Online
		hb.State = health.State
		for _, m := range tts.FetchCatalog(ctx, server) {
			if m.Active && hb.ActiveModel == "" {
				hb.ActiveModel = m.ID
			}
			hb.Models = append(hb.Models, queue.Model{ID: m.ID, Label: m.Label})
		}
	case queue.RoleVLM, queue.RoleSLM:
		hb.Healthy = httpOK(ctx, w.url+"/v1/models")
	case queue.RoleWhisper:
		// Whisper servers expose only the transcription route; reachable
		// (any HTTP response) counts as healthy.
		hb.Healthy = httpReachable(ctx, w.url+"/v1/models")
	}
	return hb
}

func httpOK(ctx context.Context, url string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode < 300
}

func httpReachable(ctx context.Context, url string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode < 500
}

// startConsumerLocked declares the queue and begins consuming it. Caller
// holds w.mu.
func (w *worker) startConsumerLocked(queueName string) error {
	if err := queue.DeclareTaskQueue(w.ch, queueName); err != nil {
		return err
	}
	tag := fmt.Sprintf("%s-%s-%d", w.role, w.serverID, time.Now().UnixNano())
	deliveries, err := w.ch.Consume(queueName, tag, false, false, false, false, nil)
	if err != nil {
		return err
	}
	w.consumers[queueName] = tag
	go func() {
		for d := range deliveries {
			w.handle(d)
		}
	}()
	return nil
}

// stopConsumers cancels every consumer (transport failure path — the server
// can't take tasks right now; the next healthy cycle re-subscribes).
func (w *worker) stopConsumers() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ch == nil {
		return
	}
	for queueName, tag := range w.consumers {
		_ = w.ch.Cancel(tag, false)
		delete(w.consumers, queueName)
	}
}

// handle executes one task. Transport-level failures (server unreachable,
// model won't load) requeue the task for another worker and pause this one;
// everything else — including AI-server HTTP errors — is an answer and goes
// back as an error reply.
func (w *worker) handle(d amqp.Delivery) {
	w.busy.Store(true)
	defer w.busy.Store(false)

	var task queue.Task
	if err := json.Unmarshal(d.Body, &task); err != nil {
		w.reply(d, queue.Reply{Error: "malformed task"})
		_ = d.Ack(false)
		return
	}

	started := time.Now()
	result, err := w.execute(task)
	switch {
	case err != nil && isInfra(err):
		log.Printf("worker: %s %s infra failure after %s: %v (requeueing, pausing)", w.role, task.Type, time.Since(started).Round(time.Millisecond), err)
		w.healthy.Store(false)
		w.stopConsumers()
		_ = d.Nack(false, true)
		return
	case err != nil:
		w.reply(d, queue.Reply{Error: err.Error()})
	default:
		w.reply(d, queue.Reply{Result: result})
	}
	log.Printf("worker: %s %s done in %s", w.role, task.Type, time.Since(started).Round(time.Millisecond))
	_ = d.Ack(false)
}

// isInfra distinguishes "this worker can't attempt tasks right now" from a
// real answer. url.Error covers connection refused/reset/DNS/timeouts.
func isInfra(err error) bool {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return true
	}
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, errModelLoad)
}

var errModelLoad = errors.New("model failed to load")

func (w *worker) execute(task queue.Task) (json.RawMessage, error) {
	// Per-task ceiling below the client's RPC timeout so a stuck call frees
	// the worker for the next task instead of wedging it.
	ctx, cancel := context.WithTimeout(context.Background(), 240*time.Second)
	defer cancel()

	switch w.role {
	case queue.RoleVLM:
		return w.executeVLM(ctx, task)
	case queue.RoleSLM:
		return w.executeSLM(ctx, task)
	case queue.RoleWhisper:
		return w.executeWhisper(ctx, task)
	case queue.RoleTTS:
		return w.executeTTS(ctx, task)
	}
	return nil, fmt.Errorf("unknown role %q", w.role)
}

func (w *worker) executeVLM(ctx context.Context, task queue.Task) (json.RawMessage, error) {
	switch task.Type {
	case queue.TypeOcrPage:
		var p queue.OcrPagePayload
		if err := json.Unmarshal(task.Payload, &p); err != nil {
			return nil, err
		}
		res, err := ocr.OcrPageData(ctx, p.Image, w.url, w.model)
		if err != nil {
			return nil, err
		}
		return json.Marshal(queue.OcrPageResult{Language: res.Language, Content: res.Content})
	case queue.TypeExtractTitle:
		var p queue.ImagePayload
		if err := json.Unmarshal(task.Payload, &p); err != nil {
			return nil, err
		}
		title, err := ocr.ExtractTitleData(ctx, p.Image, w.url, w.model)
		if err != nil {
			return nil, err
		}
		return json.Marshal(queue.TitleResult{Title: title})
	case queue.TypeDetectLanguage:
		var p queue.ImagePayload
		if err := json.Unmarshal(task.Payload, &p); err != nil {
			return nil, err
		}
		lang, err := ocr.DetectLanguageData(ctx, p.Image, w.url, w.model)
		if err != nil {
			return nil, err
		}
		return json.Marshal(queue.LanguageResult{Language: lang})
	case queue.TypeExtractToc:
		var p queue.ImagePayload
		if err := json.Unmarshal(task.Payload, &p); err != nil {
			return nil, err
		}
		entries, err := ocr.ExtractTocData(ctx, p.Image, w.url, w.model)
		if err != nil {
			return nil, err
		}
		out := make([]queue.TocEntry, len(entries))
		for i, e := range entries {
			out[i] = queue.TocEntry{Title: e.Title, Page: e.Page}
		}
		return json.Marshal(queue.TocResult{Entries: out})
	}
	return nil, fmt.Errorf("vlm: unknown task type %q", task.Type)
}

// slmModel picks the model for an slm task: each worker knows which model its
// own server carries (WORKER_SERVER_MODEL), so the same task works whichever
// worker claims it — the MacBook runs gemma4:12b-mlx while the cluster SLM
// runs gemma4:latest. The payload model is only a fallback for workers
// without one configured.
func (w *worker) slmModel(payloadModel string) string {
	if w.model != "" {
		return w.model
	}
	return payloadModel
}

func (w *worker) executeSLM(ctx context.Context, task queue.Task) (json.RawMessage, error) {
	switch task.Type {
	case queue.TypeSplitInTwo:
		var p queue.SplitInTwoPayload
		if err := json.Unmarshal(task.Payload, &p); err != nil {
			return nil, err
		}
		sug, err := ocr.SplitLineIntoSentencesOn(ctx, w.url, p.Line, w.slmModel(p.Model))
		if err != nil {
			return nil, err
		}
		out := queue.SplitInTwoResult{}
		if sug != nil {
			out.Left, out.Right = sug.Left, sug.Right
		}
		return json.Marshal(out)
	case queue.TypeSplitToMax:
		var p queue.SplitToMaxPayload
		if err := json.Unmarshal(task.Payload, &p); err != nil {
			return nil, err
		}
		parts, err := ocr.SplitLineIntoPartsOn(ctx, w.url, p.Line, p.MaxChars, w.slmModel(p.Model))
		if err != nil {
			return nil, err
		}
		return json.Marshal(queue.SplitToMaxResult{Parts: parts})
	case queue.TypeVerifyTranscript:
		var p queue.VerifyTranscriptPayload
		if err := json.Unmarshal(task.Payload, &p); err != nil {
			return nil, err
		}
		missing, reason, err := ocr.VerifyTranscriptOn(ctx, w.url, p.Expected, p.Transcript, w.slmModel(p.Model))
		if err != nil {
			return nil, err
		}
		return json.Marshal(queue.VerifyTranscriptResult{Missing: missing, Reason: reason})
	}
	return nil, fmt.Errorf("slm: unknown task type %q", task.Type)
}

func (w *worker) executeWhisper(ctx context.Context, task queue.Task) (json.RawMessage, error) {
	if task.Type != queue.TypeTranscribe {
		return nil, fmt.Errorf("whisper: unknown task type %q", task.Type)
	}
	var p queue.TranscribePayload
	if err := json.Unmarshal(task.Payload, &p); err != nil {
		return nil, err
	}
	text, err := whisper.TranscribeOn(ctx, w.url, p.Audio, p.Language)
	if err != nil {
		return nil, err
	}
	return json.Marshal(queue.TranscribeResult{Text: text})
}

func (w *worker) executeTTS(ctx context.Context, task queue.Task) (json.RawMessage, error) {
	if task.Type != queue.TypeSynthesize {
		return nil, fmt.Errorf("tts: unknown task type %q", task.Type)
	}
	var p queue.SynthesizePayload
	if err := json.Unmarshal(task.Payload, &p); err != nil {
		return nil, err
	}
	server := config.TtsServer{ID: w.serverID, Label: w.label, URL: w.url}
	if !tts.EnsureModelLoaded(ctx, server, p.Model) {
		return nil, fmt.Errorf("%w: %s on %s", errModelLoad, p.Model, w.url)
	}
	w.touchAffinity(p.Model)
	audio, duration, err := tts.SynthesizeOn(ctx, w.url, p.Model, p.Input, p.Voice, p.Speed, p.Language, p.UsesLanguage)
	if err != nil {
		return nil, err
	}
	w.touchAffinity(p.Model)
	return json.Marshal(queue.SynthesizeResult{Audio: audio, DurationSecs: duration})
}

func (w *worker) reply(d amqp.Delivery, reply queue.Reply) {
	if d.ReplyTo == "" {
		return
	}
	body, err := json.Marshal(reply)
	if err != nil {
		return
	}
	w.mu.Lock()
	ch := w.ch
	w.mu.Unlock()
	if ch == nil {
		return
	}
	if err := ch.Publish("", d.ReplyTo, false, false, amqp.Publishing{
		ContentType:   "application/json",
		CorrelationId: d.CorrelationId,
		Body:          body,
	}); err != nil {
		log.Printf("worker: reply publish failed: %v", err)
	}
}
