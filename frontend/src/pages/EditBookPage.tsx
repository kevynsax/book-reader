import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../store';
import { confirmChapters, deleteBook } from '../store/booksSlice';
import { requestBook } from '../hooks/useWebSocket';
import { Book, BookStatus } from '../types';
import { chapterStatus } from '../lib/format';
import ChapterReview, { ChapterReviewHandle } from '../components/ChapterReview';
import TextReview from '../components/OcrPageReview';
import CoverPickerModal from '../components/CoverPickerModal';
import VoiceManager from '../components/VoiceManager';

// ── Helpers ────────────────────────────────────────────────────────────────
const STATUS_STEPS: { status: BookStatus; label: string }[] = [
  { status: 'uploading',               label: 'Uploading' },
  { status: 'splitting_pages',         label: 'Splitting pages' },
  { status: 'extracting_cover',        label: 'Extracting cover' },
  { status: 'ocr_processing',          label: 'Reading pages' },
  { status: 'detecting_chapters',      label: 'Detecting chapters' },
  { status: 'awaiting_chapter_review', label: 'Ready for review' },
  { status: 'complete',                label: 'Complete' },
];

const STATUS_LABEL: Record<BookStatus, string> = Object.fromEntries(
  STATUS_STEPS.map(s => [s.status, s.label])
) as Record<BookStatus, string>;

const STATUS_ORDER = STATUS_STEPS.map(s => s.status);

// ── Status indicator ───────────────────────────────────────────────────────
function StatusIndicator({ book }: { book: Book }) {
  const [open,     setOpen]     = useState(false);
  const [eta,      setEta]      = useState<string | null>(null);
  const startRef = useRef<{ time: number; done: number } | null>(null);
  const currentIdx = STATUS_ORDER.indexOf(book.status);

  const isOcr   = book.status === 'ocr_processing';
  const ocrDone  = book.progress.current;
  const ocrTotal = book.progress.total;
  const pct      = ocrTotal > 0 ? Math.round((ocrDone / ocrTotal) * 100) : 0;

  // Seed ETA reference on first OCR page
  useEffect(() => {
    if (isOcr && ocrDone > 0 && !startRef.current) {
      startRef.current = { time: Date.now(), done: ocrDone };
    }
    if (!isOcr) { startRef.current = null; setEta(null); }
  }, [isOcr, ocrDone]);

  // Refresh ETA every 3 s while OCR is running
  useEffect(() => {
    if (!isOcr) return;
    const timer = setInterval(() => {
      if (!startRef.current || ocrDone >= ocrTotal) { setEta(null); return; }
      const elapsed    = (Date.now() - startRef.current.time) / 1000;
      const processed  = ocrDone - startRef.current.done;
      if (processed <= 0) return;
      const remaining  = ((ocrTotal - ocrDone) / processed) * elapsed;
      setEta(remaining < 60 ? `~${Math.ceil(remaining)}s` : `~${Math.ceil(remaining / 60)}m`);
    }, 3000);
    return () => clearInterval(timer);
  }, [isOcr, ocrDone, ocrTotal]);

  return (
    <div className="card py-3 px-4 space-y-2">
      {/* Status row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 shrink-0">
            {book.status !== 'error' && book.status !== 'complete' && (
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
            )}
            {book.status === 'error' && <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />}
            <span className="text-sm text-gray-300">
              {book.status === 'error' ? 'Failed' : STATUS_LABEL[book.status] ?? book.status}
            </span>
          </div>

          {/* OCR stats — immediately after the label */}
          {isOcr && ocrTotal > 0 && (
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span className="tabular-nums">{ocrDone}/{ocrTotal}</span>
              <span className="tabular-nums font-medium text-amber-400">{pct}%</span>
              {eta && <span>{eta} left</span>}
            </div>
          )}
        </div>

        <button
          className={`w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-300 transition-all shrink-0 ${open ? 'rotate-180' : ''}`}
          onClick={() => setOpen(o => !o)}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Horizontal progress bar (OCR only) */}
      {isOcr && ocrTotal > 0 && (
        <div className="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-amber-400 rounded-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {/* Expandable step list */}
      {open && (
        <div className="pt-2 border-t border-gray-800 space-y-2">
          {STATUS_STEPS.filter(s => s.status !== 'complete').map((step, i) => {
            const done    = i < currentIdx;
            const current = i === currentIdx;
            return (
              <div key={step.status} className="flex items-center gap-2.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  done ? 'bg-green-500' : current ? 'bg-amber-400' : 'bg-gray-700'
                }`} />
                <span className={`text-xs ${
                  done ? 'text-gray-400 line-through' : current ? 'text-amber-300 font-medium' : 'text-gray-600'
                }`}>
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Editable cover thumbnail ───────────────────────────────────────────────
function EditableCover({ bookId, coverVersion, onClick, size = 'md' }: {
  bookId: string; coverVersion: number; onClick: () => void; size?: 'sm' | 'md' | 'lg';
}) {
  const cls = { sm: 'w-16', md: 'w-24', lg: 'w-36' }[size];
  return (
    <div
      className={`${cls} aspect-[2/3] rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center shrink-0 cursor-pointer relative group`}
      onClick={onClick}
    >
      <img
        key={coverVersion}
        src={`/api/books/${bookId}/cover?v=${coverVersion}`}
        alt="Cover"
        className="w-full h-full object-cover"
        onLoad={e => { (e.currentTarget as HTMLImageElement).style.display = ''; }}
        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
      />
      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
        <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
export default function EditBookPage() {
  const { id }   = useParams<{ id: string }>();
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const book     = useSelector((s: RootState) => s.books.books.find(b => b._id === id));

  const [showCoverPicker,  setShowCoverPicker]  = useState(false);
  const [generating,       setGenerating]       = useState(false);
  const chapterReviewRef = useRef<ChapterReviewHandle>(null);
  // Set when the user triggers a generation, so we can auto-advance to the
  // Player page once this book reaches the `complete` status.
  const generatedRef = useRef(false);

  useEffect(() => { if (id) requestBook(id); }, [id]);

  // Auto-advance to the Player after a user-triggered generation completes.
  useEffect(() => {
    if (book?.status === 'complete' && generatedRef.current) {
      generatedRef.current = false;
      navigate(`/books/${id}`);
    }
  }, [book?.status, id, navigate]);

  if (!book) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-gray-500">Loading…</p></div>;
  }

  // A finished book has a Player page to return to; anything still in the
  // import flow goes back to the Library (the Player would only bounce here).
  const backTo = book.status === 'complete' ? `/books/${book._id}` : '/';

  const handleDelete = async () => {
    if (!confirm(`Delete "${book.name}"?`)) return;
    await dispatch(deleteBook(id!)).unwrap();
    navigate('/');
  };

  const handleConfirmChapters = async (chapters: { title: string; startPage: number }[]) => {
    await dispatch(confirmChapters({ bookId: id!, chapters })).unwrap();
  };

  const hasOcrPages   = book.ocrPages.length > 0;
  const hasChapters   = book.chapters.length > 0;
  const isGenerating  = book.status === 'generating_audio' || book.chapters.some(c => c.audioStatus === 'generating');
  const showStatus    = book.status !== 'complete' && book.status !== 'error' && !isGenerating;
  const showGenerate  = book.status === 'awaiting_chapter_review' || book.status === 'complete';
  const hasStaleAudio = book.chapters.some(c => c.audioStatus === 'stale');

  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-4">
          <button className="text-gray-500 hover:text-gray-300 transition-colors" onClick={() => navigate(backTo)}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            className="text-lg font-semibold text-gray-100 flex-1 truncate text-left hover:text-gray-300 transition-colors"
            onClick={() => navigate(backTo)}
          >
            {book.name}
          </button>
          <button
            className="text-gray-500 hover:text-red-400 transition-colors"
            aria-label="Delete book"
            onClick={handleDelete}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-6 space-y-5">

        {/* Cover + info */}
        <div className="card flex gap-5 items-start">
          <EditableCover bookId={book._id} coverVersion={book.coverVersion ?? 0} onClick={() => setShowCoverPicker(true)} size="md" />
          <div className="space-y-1 text-sm text-gray-400 min-w-0">
            <p className="text-gray-200 font-medium text-base truncate">{book.name}</p>
            {book.totalPages > 0 && <p>{book.totalPages} pages</p>}
            {book.voice && <p>Voice: <span className="text-gray-300">{friendlyVoice(book.voice)}</span></p>}
          </div>
        </div>

        {/* Status (import flow only) */}
        {showStatus && <StatusIndicator book={book} />}

        {book.status === 'error' && (
          <div className="card border-red-800 bg-red-950/20">
            <p className="text-red-400 font-medium mb-1">Processing failed</p>
            <p className="text-sm text-red-300">{book.errorMessage}</p>
          </div>
        )}

        {/* Reading pages */}
        {hasOcrPages && <TextReview bookId={book._id} ocrPages={book.ocrPages} />}

        {/* Chapters */}
        {hasChapters && (
          <>
            <div className="card">
              <ChapterReview ref={chapterReviewRef} book={book} onConfirm={handleConfirmChapters} />
            </div>

            {/* Audio generation progress — right before the Generate button */}
            {isGenerating && (
              <div className="card space-y-3">
                <h3 className="font-semibold text-gray-100">Generating audio</h3>
                {book.progress.message && <p className="text-sm text-gray-400">{book.progress.message}</p>}
                {book.chapters.map(c => (
                  <div key={c._id} className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${
                      c.audioStatus === 'complete'   ? 'bg-green-500'
                      : c.audioStatus === 'stale'      ? 'bg-amber-400'
                      : c.audioStatus === 'generating' ? 'bg-amber-400 animate-pulse'
                      : c.audioStatus === 'error'      ? 'bg-red-500'
                      : 'bg-gray-700'
                    }`} />
                    <span className="text-sm text-gray-300 flex-1 truncate">{c.title}</span>
                    <span className="text-xs text-gray-500 capitalize">{c.audioStatus}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Stale audio warning */}
            {hasStaleAudio && !isGenerating && (
              <div className="flex items-start gap-3 rounded-lg border border-amber-700 bg-amber-950/30 px-4 py-3">
                <svg className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <p className="text-sm text-amber-300">
                  Text or chapters have been modified — the current audio no longer reflects the latest content. Click <strong>Generate</strong> to rebuild.
                </p>
              </div>
            )}

            {showGenerate && (
              <button
                className="btn-primary w-full justify-center"
                disabled={generating}
                onClick={async () => {
                  setGenerating(true);
                  generatedRef.current = true;
                  try { await chapterReviewRef.current?.submit(); }
                  finally { setGenerating(false); }
                }}
              >
                {generating ? 'Generating…' : 'Generate'}
              </button>
            )}
          </>
        )}

      </main>

      {showCoverPicker && (
        <CoverPickerModal book={book} onClose={() => setShowCoverPicker(false)} />
      )}
    </div>
  );
}
