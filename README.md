# Book Reader

A full-stack web application that converts PDF books into audiobooks. Upload a PDF, OCR each page with Qwen VL, review the detected chapters, and generate per-chapter audio with a local Chatterbox TTS engine (voice cloning, language-aware).

## Stack

- **Backend** — Node.js + Express + TypeScript + Socket.IO + Mongoose
- **Frontend** — React 18 + Redux Toolkit + TypeScript + Tailwind CSS v4 + Vite → served by Nginx
- **Database** — MongoDB
- **OCR** — Qwen2.5-VL (via `https://qwenvl.kevyn.com.br`)
- **TTS** — local Chatterbox (MLX) OpenAI-compatible server in `~/projects/tts-2` (via `http://127.0.0.1:8000`); curated pt/en clone voices, detected language passed per chapter
- **PDF splitting** — `pdftoppm` (poppler-utils — installed automatically in the backend Docker image)

---

## Running with Docker Compose (recommended)

**Requirements:** Docker + Docker Compose only. No Node.js, no poppler, nothing else on the host.

### First time

```bash
cd book-reader

# Build the backend image (installs poppler-utils — ~30 s, only needed once)
docker compose build backend

# Start everything
docker compose up
```

- Frontend → **http://localhost:5173**
- Backend API → **http://localhost:3001**

### Every time after that

```bash
docker compose up
```

### Live editing

Source code is mounted directly into the containers:

| What you edit | Where | Effect |
|---|---|---|
| `backend/src/**` | `tsx watch` inside container | Backend restarts automatically |
| `frontend/src/**` | Vite HMR inside container | Browser updates without refresh |

No rebuild needed. Just save a file and the change appears.

### Stop / clean up

```bash
# Stop containers, keep all data
docker compose down

# Stop and wipe all volumes (DB + book files)
docker compose down -v
```

### Environment variables

All variables have sensible defaults. Override them in a `.env` file at the project root (Docker Compose picks it up automatically):

```dotenv
# .env  (project root)
QWENVL_API=https://qwenvl.kevyn.com.br
QWENVL_MODEL=Qwen/Qwen2.5-VL-7B-Instruct-AWQ
TTS_API=https://tts.kevyn.com.br
KOKORO_VOICE=pf_dora
KOKORO_SPEED=1.0
```

| Variable | Default |
|---|---|
| `QWENVL_API` | `https://qwenvl.kevyn.com.br` |
| `QWENVL_MODEL` | `Qwen/Qwen2.5-VL-7B-Instruct-AWQ` |
| `TTS_API` | `https://tts.kevyn.com.br` |
| `KOKORO_VOICE` | `pf_dora` |
| `KOKORO_SPEED` | `1.0` |

---

## Running locally (development)

### Prerequisites

```bash
# Node.js 20+
node -v

# poppler (for pdftoppm)
brew install poppler           # macOS
sudo apt-get install poppler-utils  # Ubuntu/Debian

# MongoDB — Docker is the easiest way
docker run -d --name mongodb -p 27017:27017 -v mongo-data:/data/db mongo:7
```

### Backend

```bash
cd backend
cp .env.example .env   # only needed once
npm install
npm run dev            # http://localhost:3001
```

### Frontend

```bash
cd frontend
npm install
npm run dev            # http://localhost:5173
```

The Vite dev server proxies `/api` and `/socket.io` to the backend automatically.

---

## Full workflow

1. **Library** — the home page lists all books and their current status.

2. **Add a book** — click "Add book":
   - **Step 1** — enter the book title and drop/select the PDF.
   - **Step 2** — navigate the rendered PDF and mark four pages:
     - **Cover page** — shown as the book thumbnail in the library.
     - **Summary page** — stored for reference.
     - **First page / Last page** — the range that will be OCR'd and turned into audio.
   - Click "Upload & process". The server saves the file and responds immediately; all background work streams back via WebSocket.

3. **Background processing** (progress visible in real time):
   - PDF pages are split into JPEG images (`pdftoppm`).
   - The cover page is extracted.
   - Every page in the reading range is OCR'd by Qwen VL. A live preview shows the text as each page completes.
   - The full OCR text is sent back to Qwen to detect chapter titles and their starting pages.

4. **Chapter review** — when the status reaches "Needs review":
   - Each suggested chapter title is searched (case-insensitive) through all OCR page text.
   - **Green** = title found — shows the page number and a text excerpt.
   - **Red** = title not found — edit the title until it matches something in the OCR text.
   - Add or remove chapters freely.
   - Click "Confirm & generate audiobook".

5. **Audio generation** — the server splits each chapter's text into the Kokoro TTS API and saves a per-chapter MP3. Progress is shown per chapter.

6. **Playback** — once complete, a chapter-aware audio player with prev/next navigation appears on the book detail page.

---

## Data layout

```
data/books/{mongoId}/
  original.pdf
  cover.jpg
  parts/
    page-001.jpg
    page-002.jpg
    …
  audio/
    chapter-001.mp3
    chapter-002.mp3
    …
```
