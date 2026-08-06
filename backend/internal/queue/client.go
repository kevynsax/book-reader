package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// Per-role RPC timeouts. TTS covers a model hot-swap; the others match the
// direct-call timeouts they replace.
var submitTimeouts = map[Role]time.Duration{
	RoleTTS:     300 * time.Second,
	RoleVLM:     180 * time.Second,
	RoleWhisper: 90 * time.Second,
	RoleSLM:     60 * time.Second,
}

// DeclareTaskQueue declares one quorum, delivery-limited, dead-lettered task
// queue. Idempotent; used for the static role queues and the dynamic
// per-model tts queues.
func DeclareTaskQueue(ch *amqp.Channel, name string) error {
	_, err := ch.QueueDeclare(name, true, false, false, false, amqp.Table{
		"x-queue-type":              "quorum",
		"x-delivery-limit":          int32(DeliveryLimit),
		"x-dead-letter-exchange":    "",
		"x-dead-letter-routing-key": DeadLetterQueue,
	})
	return err
}

// DeclareTopology sets up the static role queues (vlm/slm/whisper — tts
// queues are per-model and declared on demand), the dead-letter queue, and
// the heartbeat exchange. Safe to call from both main and workers.
func DeclareTopology(ch *amqp.Channel) error {
	if _, err := ch.QueueDeclare(DeadLetterQueue, true, false, false, false, nil); err != nil {
		return err
	}
	for _, role := range Roles {
		if role == RoleTTS {
			continue
		}
		if err := DeclareTaskQueue(ch, TaskQueueName(role)); err != nil {
			return err
		}
	}
	return ch.ExchangeDeclare(HeartbeatQueue, "fanout", false, false, false, false, nil)
}

// Dial connects with retry-once semantics; callers own reconnect loops.
func Dial(url string) (*amqp.Connection, error) {
	return amqp.Dial(url)
}

type pendingReply chan Reply

// Client is main's side of the fabric: an RPC publisher using RabbitMQ
// direct reply-to, plus the heartbeat registry.
type Client struct {
	url      string
	Registry *Registry

	mu       sync.Mutex
	conn     *amqp.Connection
	ch       *amqp.Channel
	pending  map[string]pendingReply
	declared map[string]bool
	seq      uint64
	closed   bool

	// TTS dispatcher state (dispatch.go): which servers hold one of our
	// renders right now, and the renders waiting for a server, in global
	// book order.
	dmu       sync.Mutex
	inflight  map[string]string
	waiters   []*ttsWaiter
	waiterSeq uint64

	rmu     sync.Mutex
	renders map[string]map[string]*renderTally // serverID -> model -> tally
	current map[string]RenderInfo
}

// RenderInfo describes the synthesize RPC a server is executing right now.
type RenderInfo struct {
	Model string
	Voice string
	Text  string
}

func (c *Client) setCurrent(serverID string, info RenderInfo) {
	c.rmu.Lock()
	defer c.rmu.Unlock()
	c.current[serverID] = info
}

func (c *Client) clearCurrent(serverID string) {
	c.rmu.Lock()
	defer c.rmu.Unlock()
	delete(c.current, serverID)
}

// TTSCurrent returns serverID → the render in flight on it right now.
func (c *Client) TTSCurrent() map[string]RenderInfo {
	c.rmu.Lock()
	defer c.rmu.Unlock()
	out := make(map[string]RenderInfo, len(c.current))
	for id, info := range c.current {
		out[id] = info
	}
	return out
}

// renderWindow is how many recent renders the average covers — speed shifts
// as chapters/text lengths change, so old samples age out.
const renderWindow = 20

type renderTally struct {
	samples [renderWindow]float64
	idx     int
	filled  int
	count   int64
}

func (t *renderTally) add(secs float64) {
	t.samples[t.idx] = secs
	t.idx = (t.idx + 1) % renderWindow
	if t.filled < renderWindow {
		t.filled++
	}
	t.count++
}

func (t *renderTally) avg() float64 {
	if t.filled == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range t.samples[:t.filled] {
		sum += v
	}
	return sum / float64(t.filled)
}

// RenderStats is one server's synthesize history since main booted.
type RenderStats struct {
	Count   int64
	AvgSecs float64
}

func (c *Client) recordRender(serverID, model string, secs float64) {
	c.rmu.Lock()
	defer c.rmu.Unlock()
	byModel := c.renders[serverID]
	if byModel == nil {
		byModel = map[string]*renderTally{}
		c.renders[serverID] = byModel
	}
	t := byModel[model]
	if t == nil {
		t = &renderTally{}
		byModel[model] = t
	}
	t.add(secs)
}

// TTSRenderStats returns serverID → model → average synthesize seconds (RPC
// time, including any hot-swap the render forced). Kept per model because the
// same server renders a kokoro sentence in under a second and a higgs one in
// tens of seconds — a blended average predicts nothing.
func (c *Client) TTSRenderStats() map[string]map[string]RenderStats {
	c.rmu.Lock()
	defer c.rmu.Unlock()
	out := make(map[string]map[string]RenderStats, len(c.renders))
	for id, byModel := range c.renders {
		m := make(map[string]RenderStats, len(byModel))
		for model, t := range byModel {
			m[model] = RenderStats{Count: t.count, AvgSecs: t.avg()}
		}
		out[id] = m
	}
	return out
}

// TTSInflight returns serverID → model for renders currently held on a server.
func (c *Client) TTSInflight() map[string]string {
	c.dmu.Lock()
	defer c.dmu.Unlock()
	out := make(map[string]string, len(c.inflight))
	for id, model := range c.inflight {
		out[id] = model
	}
	return out
}

func NewClient(url string) *Client {
	c := &Client{url: url, Registry: NewRegistry(), pending: map[string]pendingReply{}, inflight: map[string]string{}, renders: map[string]map[string]*renderTally{}, current: map[string]RenderInfo{}}
	go c.maintain()
	go c.dispatchLoop()
	return c
}

// maintain keeps a connection + reply consumer + registry consumer alive,
// reconnecting with backoff.
func (c *Client) maintain() {
	backoff := time.Second
	for {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()

		err := c.connect()
		if err != nil {
			log.Printf("queue: connect failed: %v (retrying in %s)", err, backoff)
			time.Sleep(backoff)
			if backoff < 15*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second

		c.mu.Lock()
		conn := c.conn
		c.mu.Unlock()
		closeCh := make(chan *amqp.Error, 1)
		conn.NotifyClose(closeCh)
		if err := <-closeCh; err != nil {
			log.Printf("queue: connection lost: %v", err)
		}
		c.failAllPending("queue connection lost")
	}
}

func (c *Client) connect() error {
	conn, err := Dial(c.url)
	if err != nil {
		return err
	}
	ch, err := conn.Channel()
	if err != nil {
		conn.Close()
		return err
	}
	if err := DeclareTopology(ch); err != nil {
		conn.Close()
		return err
	}

	// Direct reply-to consumer: replies to everything this client publishes.
	replies, err := ch.Consume("amq.rabbitmq.reply-to", "", true, false, false, false, nil)
	if err != nil {
		conn.Close()
		return err
	}
	go func() {
		for d := range replies {
			var reply Reply
			if err := json.Unmarshal(d.Body, &reply); err != nil {
				reply = Reply{Error: "malformed worker reply"}
			}
			c.mu.Lock()
			waiter, ok := c.pending[d.CorrelationId]
			delete(c.pending, d.CorrelationId)
			c.mu.Unlock()
			if ok {
				waiter <- reply
			}
		}
	}()

	// Heartbeats feed the worker registry.
	hbq, err := ch.QueueDeclare("", false, true, true, false, nil)
	if err != nil {
		conn.Close()
		return err
	}
	if err := ch.QueueBind(hbq.Name, "", HeartbeatQueue, false, nil); err != nil {
		conn.Close()
		return err
	}
	beats, err := ch.Consume(hbq.Name, "", true, true, false, false, nil)
	if err != nil {
		conn.Close()
		return err
	}
	go func() {
		for d := range beats {
			var hb Heartbeat
			if err := json.Unmarshal(d.Body, &hb); err == nil {
				c.Registry.Update(hb)
			}
		}
	}()

	c.mu.Lock()
	c.conn, c.ch = conn, ch
	// A fresh broker (e.g. restarted with empty storage) has no dynamic
	// queues; forget what we declared so they're re-created on next publish.
	c.declared = map[string]bool{}
	c.mu.Unlock()
	log.Printf("queue: connected to %s", redactAmqpURL(c.url))
	return nil
}

// redactAmqpURL strips credentials so connection logs never leak the broker
// password.
func redactAmqpURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "amqp broker"
	}
	u.User = nil
	return u.String()
}

func (c *Client) failAllPending(msg string) {
	c.mu.Lock()
	pending := c.pending
	c.pending = map[string]pendingReply{}
	c.mu.Unlock()
	for _, waiter := range pending {
		waiter <- Reply{Error: msg}
	}
}

func (c *Client) Close() {
	c.mu.Lock()
	c.closed = true
	conn := c.conn
	c.mu.Unlock()
	if conn != nil {
		conn.Close()
	}
}

var ErrNotConnected = errors.New("task queue is not connected")

// Submit publishes one task to a role queue and waits for its reply. An
// application error from the worker comes back as a plain error; delivery
// failures surface as timeouts (the broker keeps the task for the next
// healthy worker, but this caller has moved on — same contract as today's
// per-call timeout).
func (c *Client) Submit(ctx context.Context, role Role, taskType string, payload any) (json.RawMessage, error) {
	return c.submitTo(ctx, TaskQueueName(role), role, taskType, payload)
}

// ensureQueue declares a dynamic task queue once per client lifetime.
func (c *Client) ensureQueue(ch *amqp.Channel, name string) error {
	c.mu.Lock()
	if c.declared == nil {
		c.declared = map[string]bool{}
	}
	done := c.declared[name]
	c.mu.Unlock()
	if done {
		return nil
	}
	if err := DeclareTaskQueue(ch, name); err != nil {
		return err
	}
	c.mu.Lock()
	c.declared[name] = true
	c.mu.Unlock()
	return nil
}

func (c *Client) submitTo(ctx context.Context, queueName string, role Role, taskType string, payload any) (json.RawMessage, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	task, err := json.Marshal(Task{Type: taskType, Payload: body})
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	ch := c.ch
	if ch == nil || c.conn == nil || c.conn.IsClosed() {
		c.mu.Unlock()
		return nil, ErrNotConnected
	}
	c.seq++
	corrID := fmt.Sprintf("t%d-%d", time.Now().UnixNano(), c.seq)
	waiter := make(pendingReply, 1)
	c.pending[corrID] = waiter
	c.mu.Unlock()

	if queueName != TaskQueueName(role) {
		if err := c.ensureQueue(ch, queueName); err != nil {
			c.mu.Lock()
			delete(c.pending, corrID)
			c.mu.Unlock()
			return nil, err
		}
	}

	timeout := submitTimeouts[role]
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	err = ch.PublishWithContext(ctx, "", queueName, false, false, amqp.Publishing{
		ContentType:   "application/json",
		CorrelationId: corrID,
		ReplyTo:       "amq.rabbitmq.reply-to",
		Body:          task,
		DeliveryMode:  amqp.Persistent,
		// A task nobody can answer anymore must die in the queue, not be
		// rendered: past the RPC timeout the submitter has given up (or the
		// pod restarted and the reply channel is gone), so executing it only
		// wastes an AI server and delays live tasks queued behind it.
		Expiration: fmt.Sprintf("%d", timeout.Milliseconds()),
	})
	if err != nil {
		c.mu.Lock()
		delete(c.pending, corrID)
		c.mu.Unlock()
		return nil, err
	}

	select {
	case reply := <-waiter:
		if reply.Error != "" {
			return nil, errors.New(reply.Error)
		}
		return reply.Result, nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, corrID)
		c.mu.Unlock()
		// Name the exact queue: "tasks.tts.openaudio" pins a timeout to the
		// model no live worker could serve, instead of a vague role blame.
		return nil, fmt.Errorf("%s task %q on %s timed out after %s (no worker answered — none subscribed to it, or it was dead-lettered after repeated failures)",
			role, taskType, queueName, timeout)
	}
}

func submitAs[T any](c *Client, ctx context.Context, role Role, taskType string, payload any) (T, error) {
	var out T
	raw, err := c.Submit(ctx, role, taskType, payload)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, fmt.Errorf("%s %s: malformed result: %w", role, taskType, err)
	}
	return out, nil
}

// Typed helpers used by the orchestration code.

func (c *Client) OcrPage(ctx context.Context, image []byte, page int) (OcrPageResult, error) {
	return submitAs[OcrPageResult](c, ctx, RoleVLM, TypeOcrPage, OcrPagePayload{Image: image, Page: page})
}

// ExtractTitle is a single on-demand read (not part of the queued page sweep),
// so it goes over the preferred queue like the summary re-read: the highest-
// priority free vlm server (spark > macbook > kevyn-server) answers.
func (c *Client) ExtractTitle(ctx context.Context, image []byte) (string, error) {
	raw, err := c.submitTo(ctx, SummaryVLMQueue, RoleVLM, TypeExtractTitle, ImagePayload{Image: image})
	if err != nil {
		return "", err
	}
	var out TitleResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("vlm extract-title: malformed result: %w", err)
	}
	return out.Title, nil
}

// DetectLanguage is a single on-demand read like ExtractTitle — preferred
// queue, so the highest-priority free vlm server answers.
func (c *Client) DetectLanguage(ctx context.Context, image []byte) (string, error) {
	raw, err := c.submitTo(ctx, SummaryVLMQueue, RoleVLM, TypeDetectLanguage, ImagePayload{Image: image})
	if err != nil {
		return "", err
	}
	var out LanguageResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("vlm detect-language: malformed result: %w", err)
	}
	return out.Language, nil
}

func (c *Client) ExtractToc(ctx context.Context, image []byte) ([]TocEntry, error) {
	r, err := submitAs[TocResult](c, ctx, RoleVLM, TypeExtractToc, ImagePayload{Image: image})
	return r.Entries, err
}

// ExtractTocPreferred is ExtractToc over the summary queue, where consumer
// priorities route the task to the preferred vlm server first.
func (c *Client) ExtractTocPreferred(ctx context.Context, image []byte) ([]TocEntry, error) {
	raw, err := c.submitTo(ctx, SummaryVLMQueue, RoleVLM, TypeExtractToc, ImagePayload{Image: image})
	if err != nil {
		return nil, err
	}
	var out TocResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("vlm extract-toc: malformed result: %w", err)
	}
	return out.Entries, nil
}

func (c *Client) SplitInTwo(ctx context.Context, line, model string) (SplitInTwoResult, error) {
	return submitAs[SplitInTwoResult](c, ctx, RoleSLM, TypeSplitInTwo, SplitInTwoPayload{Line: line, Model: model})
}

func (c *Client) SplitToMax(ctx context.Context, line string, maxChars int, model string) ([]string, error) {
	r, err := submitAs[SplitToMaxResult](c, ctx, RoleSLM, TypeSplitToMax, SplitToMaxPayload{Line: line, MaxChars: maxChars, Model: model})
	return r.Parts, err
}

// VerifyTranscript asks an slm worker to judge whether a low-similarity
// transcript lost content (true) or is benignly different (false).
func (c *Client) VerifyTranscript(ctx context.Context, expected, transcript, model string) (VerifyTranscriptResult, error) {
	return submitAs[VerifyTranscriptResult](c, ctx, RoleSLM, TypeVerifyTranscript,
		VerifyTranscriptPayload{Expected: expected, Transcript: transcript, Model: model})
}

func (c *Client) Transcribe(ctx context.Context, audio []byte, language string) (string, error) {
	r, err := submitAs[TranscribeResult](c, ctx, RoleWhisper, TypeTranscribe, TranscribePayload{Audio: audio, Language: language})
	return r.Text, err
}

// Synthesize publishes to one server's private queue — the server AcquireTTS
// granted for this render. Servers scale down at any time, and a task in a
// dead server's queue is never redelivered to a peer, so the call is guarded
// by a liveness watch: once the server stops heartbeating it aborts early
// (instead of waiting out the full RPC timeout) and the caller retries on
// the next granted server.
func (c *Client) Synthesize(ctx context.Context, p SynthesizePayload, serverID string) (SynthesizeResult, error) {
	var out SynthesizeResult
	wctx, stop := c.watchServer(ctx, serverID)
	defer stop()
	start := time.Now()
	c.setCurrent(serverID, RenderInfo{Model: p.Model, Voice: p.Voice, Text: p.Input})
	raw, err := c.submitTo(wctx, TTSServerQueue(serverID), RoleTTS, TypeSynthesize, p)
	c.clearCurrent(serverID)
	if err == nil {
		c.recordRender(serverID, p.Model, time.Since(start).Seconds())
	}
	if err != nil {
		if ctx.Err() == nil && wctx.Err() != nil {
			return out, fmt.Errorf("tts server %q went offline mid-render", serverID)
		}
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, fmt.Errorf("tts synthesize: malformed result: %w", err)
	}
	return out, nil
}
