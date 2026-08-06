# Book Reader v2 — Full Rebuild Prompt

You are building **Book Reader v2** from scratch: a self-hosted web app that turns a scanned PDF book into a synchronized audiobook using local AI services (VLM for OCR, SLM for text tasks, TTS for synthesis, Whisper for verification). This document is the complete specification. v1 exists and works, but suffers from accumulated bugs, fragmented status logic, and a poor UI for everything related to generation progress and review. **Do not port v1 code.** Rebuild cleanly to this spec.

Read this whole document before writing any code.

---

## 1. Ground rules

### 1.1 Stack (non-negotiable)

- **Backend:** Go. Two binaries max: `server` (HTTP + WebSocket + orchestration) and `worker` (AI-service adapters). Prefer a single `worker` binary that runs **all roles as goroutines in one process** — one goroutine (or small pool) per connected AI server. Each AI server (a VLM instance, an SLM instance, a TTS instance, a Whisper instance) is serial and handles one task at a time, so there is no need for separate deployments per role. One worker process, N consumer goroutines, each with prefetch=1 against its queue.
- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS v4 (zero-config, `@import "tailwindcss"` + a small layer of component classes). Redux Toolkit for the book store. No component library.
- **Queue:** RabbitMQ. Quorum queues, delivery limit 3, dead-letter queue, direct reply-to RPC.
- **Database:** **MongoDB** (official Go driver v2). Collections: `books`, `lexicons` (+ `runs` for history, §6.1). A book embeds its chapters → sentences/tracks → segments and its ocrPages, matching the natural document shape. Discipline is mandatory: **all writes are targeted `$set`/`$push` updates with array filters — never whole-document replaces from concurrent paths** (v1's layered write strategy: full save only for flows owning the whole doc; generation runs update only their own fields; everything else field-scoped with a stamped `updatedAt`). Create the indexes you query on (`deleted`, `updatedAt`, `status`).
- **Media tooling:** poppler (`pdftoppm`, `pdfinfo`) for rasterization, `ffmpeg`/`ffprobe` for audio assembly.
- **Files on disk:** `<DATA_DIR>/books/<bookId>/` holding `original.pdf`, `parts/page-*.jpg`, `cover.jpg`, `audio/chapter-%03d__<safeVoice>.mp3`, per-segment dirs `audio/chapter-%03d__<safeVoice>/seg-*.mp3`, timeline JSON next to each chapter mp3.

### 1.2 The two task classes (core architectural requirement)

Every unit of AI work belongs to exactly one class, and the system must treat them differently end to end:

1. **Queued (batch) work** — bulk pipeline tasks nobody is waiting on interactively: OCR of hundreds of pages, sentence splitting, bulk TTS rendering, whisper verification of a full run. These flow through role queues, are scheduled fairly, survive restarts, and report progress over WebSocket.
2. **Interactive (user-driven) work** — a user clicked something and is watching: re-render this one sentence, synthesize a voice sample, split this line, re-read the summary page, typo-check this line, re-OCR this page. These must **pre-empt** batch work: highest priority in the dispatcher (reserve priority 0 for them; batch work gets priority = position in the run's work order), routed to the best/preferred server, with tight timeouts, and their result returns synchronously on the HTTP request (or as a fast WS event) — never "check back later".

Make this distinction explicit in the code: a single dispatch API like `Dispatch(ctx, task, Class Interactive|Batch, priority)` — not scattered special cases. v1 got this mostly right in its TTS dispatcher (priority-ordered waiters, priority 0 for edits, model-affinity to avoid hot-swaps, per-server private queues); keep those ideas.

### 1.3 What to keep vs redesign (UI)

- **Keep pixel-faithful:** the design system (§7.1), the Player (§7.2), the Add-a-book wizard (§7.3), the chapter-boundaries editor (§7.4).
- **Make the chapter-boundaries editor's interaction paradigm (§7.5) the default pattern for every workspace UI in the app.**
- **Redesign from scratch (functionality preserved, look and structure yours):** audio generation progress / continue / stop, the "work being done" surfaces, and the phrase/generation review UIs (§8). Suggested directions are given; improve on them.

---

## 2. Product feature inventory (complete — nothing may be dropped)

### 2.1 Library
- Grid of book cards (2/3/4/5 columns responsive), cover image (2:3), title, status badge while not complete, "Xh Ym left" listening-time remaining (sum of ready track durations minus saved position), error message line, hover-revealed delete (permission-gated by server IP allowlist), click → player if playable else edit page.
- Add book button → upload wizard.
- Settings gear (bottom-left): clear local cache.
- Instant paint from a localStorage cache of the book list; WebSocket delta sync on connect (`lastUpdate` watermark).

### 2.2 Import pipeline (per book)
Statuses: `uploading → splitting_pages → extracting_cover → reading_title → ocr_processing → detecting_chapters → awaiting_chapter_review → generating_audio → complete`, plus `error`.
1. Upload PDF (≤1 GiB) with page roles: cover page, summary (ToC) pages (multi), first content page, last content page.
2. Rasterize all pages to JPEG (150 dpi, q85); count via pdfinfo.
3. Extract cover image from the chosen page.
4. If no name given: VLM extracts the title from the cover.
5. VLM detects language from the first summary page.
6. OCR every page in `[firstPage, lastPage]` via VLM (bounded concurrency ~8): sanitize output, reflow to one sentence per line (paragraph preservation, ellipsis and abbreviation handling, balanced-bracket gluing), and compute a speech-normalized `readText` per page (see §5).
7. Extract ToC entries from every summary page in parallel; dedupe; resolve each chapter title to a page + exact character offset by accent-folded flexible search over the OCR text (try the printed page, then ceil(page/2) for 2-up scans, then all pages).
8. Land in `awaiting_chapter_review` with chapter suggestions.

**Stop/continue applies to every long-running phase, not just rendering** (v1 could not stop an import — fix that): a stop request during rasterization/OCR/chapter-detection finishes in-flight page tasks, keeps their results, marks the book paused-with-partial-progress, and resume picks up exactly where it left off. Also: resume import (keeps completed OCR pages), full reprocess with new page roles (wipes chapters/pages — require explicit confirmation in the UI since this is destructive), re-OCR a single page, dismiss error (clears error state, flips failed pages to complete), per-page manual text editing (marks overlapping rendered audio stale).

### 2.3 Chapters & boundaries
- Chapters are defined by cut points: title + startPage + startChar (character offset into that page's text). A chapter ends where the next begins.
- Editing a boundary invalidates only affected chapters (the changed one and its predecessor); untouched chapters keep their sentences and rendered audio; previously-complete audio of touched chapters becomes `stale`, not deleted.
- AI re-read of summary pages produces suggestions with found/not-found feedback; bulk fixes: shift all pages ±1, halve all pages (2 book pages per scanned page).

### 2.4 Audio generation
- Multi-voice: a book has N composite voices (`model:voice`, e.g. `chatterbox:pt-BR-FranciscaNeural`); each chapter has one track per voice; each track has one segment per sentence.
- Sentence prep: chapter text sliced by boundaries; sentences assembled one per line (lowercase continuation lines at page seams merge into the previous sentence); sentences whose normalized form exceeds ~220 chars get recursively split by the SLM (max depth 4, reject bad splits by word-similarity ≥0.8 and min-piece checks); hierarchical trace ordering (`423`, `423.1`) records lineage.
- A background pre-splitter walks chapters ahead of the renderer so TTS never idles at a chapter boundary.
- Rendering: per-segment TTS synth → Whisper transcription → word-similarity verify (threshold 0.85, diacritics stripped, digits expanded to words) → below threshold an SLM judge decides "missing content" vs "benign difference" → re-render up to N attempts → best take kept and flagged `needsReview` with all transcripts stored. Verification skipped when Whisper is down or text < 8 chars.
- Scheduling: work order is voice-major (all chapters for voice 1, then voice 2). One chapter per TTS model in flight so all capable servers converge on the same chapter; open a later job early only when some healthy server can't help with any in-flight chapter. Segments render through a bounded pool (~5); real parallelism = number of healthy TTS servers.
- Chapter assembly (background, off the render path): ffmpeg concat with full decode + re-encode (`libmp3lame -q:a 2`, volume gain 1.15) — never byte-concat (drops ~20 ms per boundary and desyncs the timeline). Titles (≤5 words) get 0.7 s silence before/after and a +10% volume copy. Timeline offsets computed from **real decoded durations**, written as `[{text, start, end}]` ms-rounded JSON.
- Entry points: generate all (resume-aware), add voice(s) to a finished book, regenerate voice, regenerate chapter, regenerate chapter+voice, continue chapter+voice (missing segments only), reassemble from existing segments, remove voice (deletes files).
- Stop: cooperative — in-flight renders complete and are kept; pending/generating → stale/pending; book → complete with "Stopped". Works even when no run is live (repairs stuck DB state). On server boot, recover interrupted runs by the same reconciliation. Provide the same repair as a CLI subcommand.
- Sample synthesis: ≤1500 chars of the book's first substantial text, rendered interactively (priority lane), streamed back on the HTTP response.
- Single-book run lock: one generation run per book; short interactive edits queue behind it via a per-book lock; conflicting HTTP writes get 409.

### 2.5 Sentence-level editing (available per chapter+voice)
- List sentences with per-segment audio status; edit text (re-renders all voices, priority lane), insert after, delete (blocked when it's the last one; renumbers and reassembles), regenerate one segment (optionally with a different synth model/voice while storing into the same track), approve a `needsReview` flag, preview a segment's audio.
- Mismatch review: server aggregates every `needsReview` segment across the book with its whisper transcripts, grouped per sentence per voice.
- Unspeakable-sentence repair (boot-time, idempotent): pure-punctuation sentences (which wedge some TTS engines) get folded into the previous sentence, orphan audio deleted, merged sentence re-rendered.

### 2.6 Player (see §7.2 for exact UI)
Chapter audio streaming with HTTP Range/ETag, read-along timeline, per-sentence navigation, 30-s skips, speed 0.75–2×, chapter picker, voice switching that preserves the **sentence position** (not the clock time) across voices, position persistence per book, auto-advance and auto-resume when the next chapter finishes rendering mid-listen, "X% listened / Ym left".

### 2.7 Voices & TTS fleet
- Model catalog aggregated from all TTS servers (`/v1/models`), live voice lists per model (`/v1/audio/voices`), named-voice vs cloned-voice model handling, hot-swap model loading (`/v1/models/load`, poll ready, ~180 s), model-affinity scheduling.
- Server status registry fed by worker heartbeats (never probed from the API path): online/offline, active model, currently rendering (voice + truncated text), render count and average seconds per render.

### 2.8 Lexicon & speech normalization
- Per-language lexicons of acronyms/terms → spoken form, editable via API/UI, seeded with defaults (Bible translations etc. for en/pt), cache invalidated on save.
- Read-time normalization pipeline (applied to produce `readText` / synthesized text, never mutating the display text): scripture references (book chapter:verse, ranges, paired books), `v./vv./pp./ch.` expansions, acronym substitution (case-sensitive, longest first), all remaining bare numbers spelled out as words (en/pt number tables).

### 2.9 SLM utilities (interactive lane)
- Split a long line in two; split to max length; typo/grammar review of a line returning a corrected version; model list; per-call model override. Balance across SLM servers by weight/in-flight; race all servers for latency-critical calls.

### 2.10 Misc
- Book rename, soft delete (IP-allowlisted), cover replacement (upload image or pick a page), page image serving, health endpoint, CORS for the frontend origin, i18n (en/pt/es — English string is the key, auto-detected once from browser).

---

## 3. Backend architecture

### 3.1 Processes

**`server`** — HTTP API, WebSocket hub, orchestrator (import pipeline + render scheduler + dispatcher), MongoDB, filesystem. On boot: migrate DB, seed lexicons, recover interrupted runs, start unspeakable repair in background.

**`worker`** — connects to RabbitMQ and to the AI servers listed in config. For each configured AI server, one consumer goroutine: health-probe loop (~5 s) → publish heartbeat to a fanout exchange → consume its queue only while healthy, prefetch 1. Roles: `tts`, `vlm`, `slm`, `whisper`. TTS consumes a **per-server queue** (`tasks.tts.server.<id>`) because the dispatcher picks the server; vlm/slm/whisper consume shared role queues (`tasks.vlm`, etc.). VLM additionally consumes an interactive queue (`tasks.vlm.interactive`) with consumer priority so the preferred (fastest) server wins interactive work. Infra failures → nack+requeue and mark unhealthy; application errors → error reply + ack (never requeue). All configured servers can live in one worker process; also support running several worker processes if the user wants (the queues make this transparent).

### 3.2 Queue protocol
- RPC over direct reply-to: task `{type, payload}` with correlation id, persistent delivery, and per-message TTL equal to the RPC timeout so abandoned tasks never burn a serial AI server. Timeouts: TTS 300 s, VLM 180 s, Whisper 90 s, SLM 60 s.
- Task types: `ocr-page`, `extract-title`, `detect-language`, `extract-toc` (vlm); `split-in-two`, `split-to-max`, `verify-transcript` (slm); `transcribe` (whisper); `synthesize` (tts).
- Heartbeat registry in the server: 15 s expiry, keyed role|serverId, carries healthy/busy/activeModel/models.
- TTS dispatcher: blocking acquire of a healthy free server advertising the model; waiters ordered by (priority asc, FIFO); prefer a server whose active model already matches; 2 s re-match tick; 90 s grace before "no TTS server online for model X"; liveness watch during a render (6 missed probes → cancel with "server went offline mid-render"); telemetry for in-flight/current/stats.
- Reconnect with backoff everywhere; a wiped broker must re-create queues transparently.

### 3.3 MongoDB schema (guideline)
`books`: status, page roles, language, progress fields, error, timestamps, `voices[]`, `ocrPages[] {page, text, readText, status, error}`, `chapters[] {_id, title, startPage, startChar, sentences[], tracks[]}`; sentence = `{_id, order, text, display, original?, traceOrder?, split lineage}`; track = `{voice, audioPath?, audioDurationSecs?, audioStatus, audioError?, segments[]}`; segment = `{sentenceId, audioPath?, durationSecs?, audioStatus, audioError?, needsReview, whisperResults[]}`. `lexicons`: `{language, acronyms[]{term,say}}`. Derive track status from segments (`generating > error > stale > all-complete > pending`) — in one place. Updates are field/array-scoped `$set` with array filters (see §1.1 stack note); v1's clobbering bugs came from concurrent whole-document saves — design the store layer so that's impossible. Wire DTOs for the frontend strip sentences/segments from list payloads and include `segmentsDone/segmentsTotal` per track.

### 3.4 WebSocket contract
`/ws`, JSON envelope `{event, data}`. Client sends `subscribe-to-books {lastUpdate}` and `subscribe-to-book {bookId}`; server replies `books:sync` (delta by watermark). Server broadcasts `book:deleted` and a single patch channel `book:update` carrying `{bookId, updatedAt}` plus any subset of: name/status/error/language/cover/totalPages/voices, `progress`, `chapters`, `ocrPages`/`ocrPage`, `splitProgress` (transient), `voiceProgress {voice, chapterIdx, current, total, message}`, `chapterUpdate`, `segmentUpdate`, `sentenceUpdate`, `sentenceDeleted`. Improvement over v1: consider room-scoped delivery (per book) instead of broadcast-to-all, and make **every** live surface WS-driven — the frontend should never poll (v1 polled `/api/servers` every 5 s from two components at once; push a `servers:update` event instead).

### 3.5 HTTP API
Reproduce v1's surface (rename paths freely, keep capabilities): book CRUD + rename + soft delete + can-delete, upload (multipart), reprocess, resume, stop-import (new), dismiss-error, page image, cover get/put (file or page), chapter audio (Range + ETag) and timeline, sentences list/edit/insert/delete/regenerate/approve + segment audio, mismatches, generate/stop/reassemble, per-voice and per-chapter regenerate/continue, voices add/remove, sample, summary detect/re-read, page text put, re-ocr, line-split/line-typos + SLM model list, TTS models/voices/servers, lexicon get/put, health. Async writes ack immediately and stream progress over WS; interactive tasks return their result on the response. Consistent error envelope `{error}`; 409 for busy/locked conflicts.

---

## 4. Frontend architecture

- Three routes: `/` (library), `/books/:id` (player), `/books/:id/edit` (workspace).
- Single WS singleton with backoff reconnect, outbox, and delta sync; RTK store with a `book:update` patch reducer; localStorage cache of the list for instant paint.
- **One API module** — every server call lives in one typed file (v1 scattered raw `fetch` through components; don't).
- **One status vocabulary** — a single module exporting the status enums, label maps, color maps, and derivation helpers (`isGenerating(book)`, `trackStatus`, `voiceIsGenerating`) used by every component. v1 had four conflicting definitions of "generating"; this is the single biggest bug source to eliminate.
- One modal/confirm system (no native `confirm()`/`alert()` anywhere), one portal layer manager (Esc closes the topmost only).
- i18n: `t(englishSource, vars)` with pt/es dictionaries keyed by the English string.

---

## 5. Design system — reproduce exactly

Permanent dark theme, no toggle. Font **Inter** (400/500/600/700 from Google Fonts); mono stack for all numbers/times/page counts, `tabular-nums` on counters. Tailwind v4, zero config; the design system is one small CSS file:

- Surfaces: page `bg-gray-950`, cards/modals `bg-gray-900`, inputs/image wells `bg-gray-800`; borders `gray-800`/`gray-700`.
- Text: `gray-100` primary → `gray-400` secondary → `gray-500` labels → `gray-600` faintest.
- **Accent amber**: `amber-600` fills (hover `amber-500`), `amber-500` bars/rings/slider thumbs, `amber-400`/`amber-300` text and hovers. Semantic: green/emerald = ready, red = error, sky = secondary info, purple = review, yellow = processing.
- Component classes: `.btn` (`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all duration-150 disabled:opacity-50`), `.btn-primary` amber, `.btn-secondary` gray-700, `.btn-danger` red-700; `.card` (`bg-gray-900 rounded-xl border border-gray-800 p-6`); `.input` (gray-800, amber focus ring); `.label`; `.badge-*` per status (colored `*-900/50` bg + `*-300` text, `px-2 py-0.5 rounded text-xs`); `.progress-bar` (`h-2 bg-gray-800 rounded-full overflow-hidden`) + `.progress-fill` (`bg-amber-500`, `transition-all duration-300`). Kill number-input spinners globally.
- Chrome patterns: sticky header `border-b border-gray-800 bg-gray-900/50 backdrop-blur sticky top-0 z-10`; small modal = overlay `fixed inset-0 bg-black/70 … z-50 p-4`, panel `bg-gray-900 rounded-2xl border border-gray-700 shadow-2xl`, header row with a `×` glyph close; large work modal = overlay `bg-gray-950/80 backdrop-blur`, panel `~1120×720 max-w-[97vw] max-h-[94vh] rounded-xl flex flex-col`; fullscreen portal `fixed inset-0 h-[100dvh] bg-gray-950` with body-scroll lock. Icons: inline Heroicons-style SVGs, `w-4/5 h-4/5`, stroke 2. Backdrop-click and Esc close modals; micro-copy lives in `title=` tooltips and inline header hints.

---

## 6. New features & improvements to include in v2

Beyond fixing v1's problems, build these in — each addresses a real gap observed in v1. Items marked *(optional)* may be deferred, but leave room for them in the design.

### 6.1 Reliability / architecture
- **Run history collection.** Record every generation and import run in a `runs` collection (started/finished, trigger, per-chapter outcomes, failure reasons, tokens of work done). Powers a "last run" summary in the UI and makes "why did chapter 12 fail last night" answerable. v1 kept nothing.
- **Deterministic re-render skipping.** Store a hash of the normalized sentence text + voice + engine settings on each segment; on regenerate/continue, skip segments whose hash matches and whose file exists. Makes "Regenerate voice" cheap after small edits.
- **Server-side listening position.** Persist `{bookId, voice, chapterIdx, time}` in Mongo (debounced writes), with localStorage as offline fallback. v1's localStorage-only position means progress is lost per browser/device.
- **Global fleet queue view.** One run per book, but the fleet is shared across books. Show which book currently owns each TTS server and let the user reorder queued runs. v1 gave no visibility when two books competed.
- **Browser notification** (opt-in) when a generation run or import finishes/fails while the tab is backgrounded.
- **Structured logging + Prometheus metrics** (queue depth, RPC latency per role, render secs per server, verify failure rate). *(optional but cheap in Go)*

### 6.2 Audio quality
- **Loudness normalization (EBU R128 two-pass via ffmpeg) per chapter** instead of v1's fixed ×1.15 gain — consistent volume across voices and engines.
- **Silence trimming** at segment edges before concat (ffmpeg `silenceremove`, conservative thresholds) — some TTS engines pad 0.5–1 s of dead air per sentence, which compounds over a chapter.
- **M4B export** *(optional)*: download a finished book as a single `.m4b` with chapter markers and the cover embedded — the assembly pipeline already has everything needed.

### 6.3 Review & text tooling
- **Lexicon management UI.** v1 has a full lexicon API (per-language acronym → spoken-form, seeded defaults) but **no frontend for it**. Add a settings surface to edit terms, and — higher value — an inline "add to lexicon" action in the OCR review's speech-normalization tooltip and in the sentence workspace, pre-filled with the selected word. Saving invalidates the normalizer cache and marks affected rendered audio stale.
- **Server-side batch typo/normalization scan** (replaces the 40-request client fan-out): one job per page or chapter, results streamed over WS, cancellable, findings persisted so review survives reloads.
- **Per-page reviewed flag + review progress** ("143/300 pages reviewed") so long books are resumable — v1 loses all review state on close.
- **Heading-based chapter detection fallback** *(optional)*: when a book has no usable ToC, ask the VLM to flag heading candidates per page during OCR and offer them as boundary suggestions in the chapter editor.
- **Full-text search across a book** *(optional)*: a Mongo text index over `ocrPages.text` (or in-memory search per book — the text is small); jump from a hit straight into the review workspace or player position.

### 6.4 Player extras (additive only — the core player stays exactly as specced in §7.2)
- **Media Session API**: lock-screen / hardware-key play-pause, ±30 s, next/prev sentence, cover art. Pure addition, no visual change.
- **Sleep timer** (15/30/45/60 min + end of chapter), reachable from the tools row.
- **Persist playback speed per book** (v1 resets to 1× on every reload).
- **Offline/PWA caching of rendered chapters** *(optional)*: service worker caching chapter mp3s + timelines for listening away from the home network.



---

## 7. UIs to reproduce faithfully

### 7.1 Design system — see §5.

### 7.2 The Player — reproduce exactly (this UI is considered perfect)

Route `/books/:id`. `max-w-3xl` column. Sticky header: back-chevron + "Library" (left, flex-1), `btn-secondary` "Edit" (right). If the book isn't complete and has no playable chapter, redirect to the edit page — but the player IS allowed mid-generation as soon as one chapter is ready.

**Book header card** (`.card flex gap-5 items-start`): 9-rem 2:3 cover well (gray-800 fallback, cache-busted by a cover version), then title (truncate), "{n} pages", the voice chips/selector, and "Xh Ym left" when >60 s remain.

**Generating banner** (only while status is generating): full-width amber-tinted button — pulsing amber dot + "Generating audio · {ready}/{total} chapters ready", right side "View progress →", navigates to the edit page.

**Audio player card** (`.card space-y-4`, one hidden `<audio preload="metadata">`):
1. **Chapter line:** left "Chapter {i} of {n} · {title}" (`text-sm font-medium`, gray-500 prefix), right `mono text-xs` `current / duration` (`m:ss`, `h:mm:ss` over an hour).
2. **Scrubber:** the `.progress-bar`/`.progress-fill` pair, click-to-seek (no drag, no thumb), fill animates 300 ms.
3. **Read-along stage** (`min-h-[7rem]`, centered): exactly two lines — the **current sentence** big (`text-base sm:text-lg text-gray-100`, click = replay this line) and the **next sentence** dim (`text-xs text-gray-600 line-clamp-1`, click = skip ahead). No scrolling transcript, no word-level highlight. Driven by a timeline `[{text,start,end}]` fetched per chapter+voice; active line by binary search on `currentTime + 0.15 s` lookahead.
4. **Transport** (centered, gap-2; buttons `text-gray-300 hover:text-amber-400`, disabled opacity-30): prev-sentence ‖ back-30s (drawn arc with "30" inside) ‖ **56 px solid play/pause** ‖ fwd-30s ‖ next-sentence. Prev/next sentence roll over chapter boundaries.
5. **Two labelled tools** (gap-12): **Speed** (mono value "1.5x" above the caption "Speed") and **Chapters** (list icon above "Chapters") — each opens a small modal.
6. When more chapters are still rendering: pulsing amber dot + "More chapters are still generating…".
7. Footer (border-t): "{pct}% listened" · "{time} left".

**Chapter modal:** `max-w-sm`, `max-h-[80vh]` scroll list; rows "1. Title", selected `bg-amber-600/20 text-amber-400`; choosing plays immediately. **Speed modal:** `max-w-xs`, speeds `0.75 / 1 / 1.25 / 1.5 / 1.75 / 2`, mono rows, "1x — Normal"; applies to `playbackRate` instantly; not persisted.

**Behavioral spec (all must-keep):**
- Plays only `complete` tracks of the active voice; one `<audio>` re-src'd per chapter; audio URL carries a cache-buster derived from track duration so a re-rendered sentence forces both audio and timeline to refresh.
- Auto-advance on `ended`; if the next chapter isn't rendered yet, wait and **auto-resume the moment it appears** (watch the store).
- Position persistence per book (`{chapterIdx, time}` in localStorage): saved on pause, every ~5 s of playback drift, before chapter switches, on pagehide/visibility-hidden/unmount; restored via seek-on-loadedmetadata. The library card reads the same key for "left" times.
- **Voice switch preserves the sentence index, not the clock:** capture the active line, load the new voice's timeline, seek to that sentence's start; suppress the saved-position restore while such a seek is pending.
- Active voice persisted per book; falls back to the first voice if the stored one disappears.
- Below the player: a toggle "Edit sentences in this chapter" revealing the sentence editor for the current chapter+voice, and the mismatch-review card when the book has flagged sentences (functionality in §8.4 — the *placement* stays, the design is yours).
- Deliberate non-features — do NOT add: sleep timer, media-session/lock-screen integration, keyboard shortcuts, volume control, waveforms, drag-scrub.

### 7.3 The Add-a-book wizard — reproduce exactly

Modal (`max-w-lg`, NOT backdrop-dismissible), header "Add book / Step {n} of 2" with back-chevron on step 2, ✕ close. Errors as a red banner above the body.

**Step 1 — file only** (no name field; the title is OCR'd later): a dashed dropzone (`border-2 border-dashed border-gray-700 rounded-lg p-8`, hover border-amber-600) — click to browse or drop, `application/pdf` only; empty state = cloud icon + "Drop a PDF here or *browse*" + "PDF only"; filled = amber doc icon + filename + size in MB. Footer `btn-primary w-full` "Next: Select pages", disabled without a file.

**Step 2 — page roles over a client-rendered PDF** (pdf.js, worker via `new URL(...pdf.worker.min.mjs, import.meta.url)`, fit-to-width scale capped 1.5×, render-cancellation on page flips):
- A 2×2 grid of big role toggles — **Cover / Summary / First page / Last page** (`rounded-2xl py-3 px-4 border-2`; active = amber fill; set-elsewhere = amber-tinted with "p.{n}" suffix; unset = gray). Tapping a tile assigns the **currently previewed page** to that role. Summary is multi-select toggle ("tap to add/remove" hint, comma-joined page list). First/Last **auto-swap** if the user inverts the range.
- Preview viewport: gray-800 rounded frame; hover-revealed full-height edge chevrons over black gradients; "Rendering…" overlay; canvas scrollable `max-h-[420px]`; floating bottom-center pill `bg-black/60 backdrop-blur rounded-full` with a typable page number `/ total`; a hairline amber range slider beneath for fast scrubbing.
- Submit `btn-primary w-full` "Create", enabled only when **all four roles are set**. Upload = multipart POST; on success subscribe to the book over WS, close, navigate to the edit page where import progress streams in.

**Cover picker modal** (from the edit page, keep as-is): two modes — drop/browse an image (JPG/PNG/WebP, object-URL preview) *or* pick a page with the same mini page-navigator; active mode gets the amber border; footer Cancel / "Set as cover".

### 7.4 The chapter-boundaries editor — reproduce exactly

Large work modal (~1120×720). Header: "Edit chapters" + inline hint *"Pick each chapter's page, then click the word it starts at."* + amber-outlined "+ add chapter" + ✕ (Esc).

**Two-column split.** Left column (~32 rem):
- *Top (≤45%):* the chapter rows — click-to-edit title (input commits on blur/Enter/Esc); a **segmented page stepper** `[◀][ 123 ][▶]` with **press-and-hold auto-repeat (350 ms delay, then 75 ms interval, pointer-capture)**; stepping clamps to the book range, invalidates the picked word, selects the row, and drives the preview; a remove ✕ per row.
- *Bottom:* the **StartPicker** — caption *"Where does “{title}” start on page {p}? Click the first word."* with a green `from "{word}"` / red `"{word}" not found` status; then the **entire OCR page text rendered as clickable word tokens** (whitespace runs preserved): words before the cut dimmed gray-600 (they belong to the previous chapter), words after gray-300, the start word a green pill (`bg-green-950/70 text-green-300 ring-1 ring-green-700`); hover amber. Clicking a word records the exact character offset and **autosaves immediately**.

Right column: the reusable **PagePreview** — scanned page image, wheel zoom 1–6× (non-passive), drag-pan when zoomed, double-click zoom/reset, +/−/reset button stack, hover edge chevrons, typable page pill (red while invalid), custom amber-thumbed range slider. It always follows the left selection.

**No explicit save anywhere** — every interaction persists; the footer has only "Done".

**Inline chapter list** (on the workspace, collapsed form): rows with a green/red validity dot (page in range AND start word locatable), index, title, `from "{word}"`, and the derived range `p.{from}–{to}` (end = next chapter's start); clicking a row opens the editor on it. Header icon-buttons: re-read summary with AI, view summary page, add chapter.

**AI suggestions modal:** same split layout over the re-read results; a bulk toolbar `[◀ shift all −1][½ halve all][▶ +1]`; per-row steppers with live found/not-found title coloring (re-locate on every step); "Replace chapters" replaces the whole set (warn about, rather than silently drop, out-of-range titles — v1 dropped them silently; fix that).

### 7.5 The default UI paradigm (apply to every workspace surface you design)

Distilled from the boundaries editor — this is the app's interaction contract:

1. **Split view:** editable list/target on the left, ground-truth source (page image / audio) on the right; the right pane always follows the left selection.
2. **Selection drives preview instantly** — no apply/refresh step.
3. **Coarse then fine:** pick the page/unit with redundant affordances (press-and-hold steppers, slider, typable pill, edge arrows), then pick the exact point by clicking directly **in the content** (a word, a sentence).
4. **Direct manipulation over form fields** — numeric inputs are the fallback, never the primary path.
5. **Continuous validity feedback in color:** green = located/valid, red = invalid/not found, dimmed = belongs to the previous unit, amber = active.
6. **Bulk transforms next to per-item edits** (shift-all, halve-all).
7. **No explicit save** — autosave on interaction/blur/close; footers say only "Done".
8. **Esc/backdrop close; tooltips carry micro-copy; hints inline in headers.**

---

## 8. UIs to redesign (functionality fixed, design open — improve on these suggestions)

These are the parts of v1 the owner dislikes: buggy, fragmented, contradictory. Preserve every capability listed; do not preserve the structure.

### 8.1 Generation progress / continue / stop

**v1's failures to avoid:** three unconnected progress surfaces with three different definitions of "generating"; a global bar suppressed whenever per-voice bars exist; a bar that auto-hides 700 ms after finishing (completed steps vanish without record); one button meaning Generate/Continue/Retry/Generating depending on hidden state; ETA that silently disappears; a color-dot legend because the dots weren't self-evident; native `confirm()`s; `.catch(() => {})` leaving optimistic "generating" dots stuck forever.

**Capabilities to preserve:** start generation (with voice choice on first run), stop (cooperative, always available, obvious), continue/retry at book, voice, chapter, and chapter+voice granularity; per-voice × per-chapter status with segment-level progress of the active chapter; ETA from live server throughput; live TTS fleet status (per server: online/rendering what/avg secs); delete a chapter that produced no audio; stale-audio warning and regeneration after edits.

**Suggested direction:** one **Generation panel** built on the §7.5 paradigm — left: a voice × chapter matrix/list where every cell shows one unambiguous status from the single shared vocabulary, selectable; right: a live detail pane for the selection (segment progress bar, currently rendering sentence text streamed from the server registry, per-server activity, errors with their actual messages). One primary action whose label is always explicit and predictable, with granular continue/retry actions on the selected cell — never overloaded. A persistent, compact run log (what finished when, what failed and why) instead of self-hiding bars. All data over WS push (server status included — no polling). Stop is always visible during a run and reports what it did.

### 8.2 Import progress ("work being done")

**Preserve:** the 7-step pipeline status, per-page OCR done/total with failures, ETA from observed throughput, resume / restart-with-new-roles / dismiss-error, live page text streaming in as pages finish. **Add:** a Stop button for the import itself (new in v2, §2.2) — always visible while importing, mirroring generation's stop semantics.
**Suggest:** a single import timeline (steps as a vertical checklist with real timestamps, current step live), with per-page OCR shown as a compact grid of page cells (colored by status, clickable → that page in review) rather than a bare counter. Completed information stays visible. Failures are first-class: a failed page shows its error and a one-click re-OCR.

### 8.3 OCR / text review

**Preserve every capability:** side-by-side page image ↔ editable text; speech-normalization diff marks with hover "what will be spoken"; glued-footnote-digit marks; long-line detection and the three split strategies (punctuation window with rebalance, conjunction, SLM) with before/after preview; per-line AI typo review with word-level accept/reject; re-OCR page; auto-save with saved flash; undo stack; wrap-aware line markers; jump between flagged lines; SLM model pickers.
**v1's failures:** a 1800-line component stacking four portals at three z-layers; findings wiped on close; per-line HTTP fan-out (40+ requests per click, no cancellation); no record of which pages were reviewed; the card auto-jumping to the newest OCR'd page while you're reading another.
**Suggest:** one fullscreen **Review workspace** (paradigm §7.5: page list/grid left rail → page image + text editor split), with *modes* (Text / Long lines / AI review) switched inline instead of stacked portals. Persist review state server-side: a per-page `reviewed` flag and stored findings, so a 300-page book is resumable. Batch the typo scan into one server-side job (SLM fan-out happens in Go, streamed back over WS with cancel). Never steal the user's page position.

### 8.4 Phrase / generation review (mismatches + sentence editor)

**Preserve:** the aggregated needs-review list (sentence text, chapter, per-voice whisper transcripts "heard: …"); per-voice audio preview; re-render one voice or all; re-render with a different synth model/voice into the same track; edit text & re-render; insert after; approve ("sounds fine"); delete with confirmation; the per-chapter sentence list with status dots, inline edit, preview, retry, delete; live WS updates.
**v1's failures:** two overlapping components (MismatchReview on the player, SentenceEditor below it) with different row designs for the same entity; sequential await when re-rendering all voices; debounced full re-fetches instead of patches; swallowed errors.
**Suggest:** one **Sentence workspace** per book (paradigm §7.5): left = filterable sentence list (filter: needs-review / errors / edited / all; grouped by chapter), right = detail pane with the sentence text editor, one row per voice (play, waveform-free duration, transcript vs expected with the diff highlighted, re-render, approve). The player keeps only a slim entry point ("N sentences need review → open"). Patch state from WS events; surface every failure inline on the row it belongs to.

### 8.5 Voice picker / generate modal

**Preserve:** model chips from the live catalog, language filter, multi-select voice grid mixing engines, instant sample playback per voice, selected chips, server status visibility, exclusion of voices already on the book.
**Suggest:** keep it simple but fix: real language metadata instead of inferring from voice-id prefixes; a single sample player with obvious loading state; disable unavailable models with the reason shown.

---

## 9. Configuration

Env-driven, `.env` supported. Keep v1's knobs and defaults: `PORT` (3001), `MONGODB_URI`, `AMQP_URL`, `DATA_DIR`, `FRONTEND_ORIGIN`, `DELETE_ALLOWED_IPS`, `TTS_SERVERS` (`id|label|url` list), SLM primary/fallback URLs + weights + `SLM_MODEL`/`SLM_SPLIT_MODEL`, `WHISPER_MODEL`, verify knobs (`TTS_VERIFY`, threshold 0.85, attempts, min chars 8), `TTS_MAX_SENTENCE_CHARS` 220, concurrency (`TTS_CONCURRENCY` 5, `OCR_CONCURRENCY` 8), audio gains (volume 1.15, title 1.1, title silence 0.7 s, title max words 5), default voice, RPC timeouts. Worker config: per-AI-server entries with role, id, label, url, optional model override, skip-models, consumer priority, health interval.

External service contracts (all OpenAI-shaped, keep):
- TTS: `GET /health` `{state,model,backend}`, `GET /v1/models`, `POST /v1/models/load`, `POST /v1/audio/speech {model,input,voice,response_format:"mp3",speed,language?}` (+ optional `X-Audio-Duration-Seconds`), `GET /v1/audio/voices?model=`.
- VLM/SLM: `POST /v1/chat/completions` (temperature 0; VLM sends the page as a base64 data-URL image part, max_tokens 4096; SLM max_tokens 512).
- Whisper: `POST /v1/audio/transcriptions` multipart.

---

## 10. Quality bar

- Table-stakes: no polling where WS exists; no duplicated status logic; no swallowed errors (every failure reaches the UI attached to the thing that failed); no native `confirm`/`alert`; no dead props; destructive actions (reprocess, delete, replace chapters) always confirm and say exactly what will be lost.
- Concurrency safety: one generation run per book; interactive edits lock per book and pre-empt batch TTS via the priority lane; DB writes are field/array-scoped, never whole-document replaces from concurrent paths; the stop flag is checked at segment and chapter boundaries and **must be honored by resume/reprocess flows too** (v1 had a bug where rerunning import ignored the stop flag and wiped chapters).
- Crash safety: server boot reconciles any `generating` state; segment files are the source of truth (a "complete" segment whose file is missing re-renders); assembly always re-derives the timeline from decoded durations.
- Tests where they pay: sentence reflow/splitting, speech normalization, the flexible title matcher, similarity verify, track-status derivation, the dispatcher's priority/affinity logic, timeline assembly math.
- Ship with docker-compose for MongoDB + RabbitMQ, boot-time migrations/seeding, and a Makefile covering dev (Vite proxy → server), build, and test.

Build it in this order: schema + queue + worker skeleton → import pipeline → chapter review UI (the paradigm reference) → generation engine + new generation panel → player → review workspaces → polish.
