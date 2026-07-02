import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../store';
import { confirmChapters, deleteBook, renameBook, generateBook, stopBook, regenerateVoice, regenerateChapterVoice, continueChapterVoice, resumeBook, dismissBookError } from '../store/booksSlice';
import { requestBook } from '../hooks/useWebSocket';
import { Book, BookStatus } from '../types';
import { chapterStatus, bookVoices, trackFor, hasPlayableAudio } from '../lib/format';
import { useVoiceLabel } from '../hooks/useVoiceLabel';
import ChapterReview, { ChapterReviewHandle } from '../components/ChapterReview';
import TextReview, { TextReviewHandle } from '../components/OcrPageReview';
import CoverPickerModal from '../components/CoverPickerModal';
import VoiceManager from '../components/VoiceManager';
import GenerateVoiceModal from '../components/GenerateVoiceModal';
import ConfirmDialog from '../components/ConfirmDialog';
import ReimportModal from '../components/ReimportModal';
import { t } from '../i18n';

const STATUS_STEPS: { status: BookStatus; label: string }[] = [
  { status: 'uploading',               label: t('Uploading') },
  { status: 'splitting_pages',         label: t('Splitting pages') },
  { status: 'extracting_cover',        label: t('Extracting cover') },
  { status: 'reading_title',           label: t('Reading title') },
  { status: 'ocr_processing',          label: t('Reading pages') },
  { status: 'detecting_chapters',      label: t('Detecting chapters') },
  { status: 'awaiting_chapter_review', label: t('Ready for review') },
  { status: 'complete',                label: t('Complete') },
];

const STATUS_LABEL: Record<BookStatus, string> = Object.fromEntries(
  STATUS_STEPS.map(s => [s.status, s.label])
) as Record<BookStatus, string>;

const STATUS_ORDER = STATUS_STEPS.map(s => s.status);

// A labelled progress bar that, once it fills to 100%, holds briefly then
// collapses out (fade + height) instead of lingering. Re-expands if a fresh
// sub-100% value arrives (e.g. the next chapter starts splitting).
function AutoHideBar({ current, total, message, color }: {
  current: number; total: number; message: string; color: 'amber' | 'sky';
}) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (pct < 100) { setHidden(false); return; }
    const timer = setTimeout(() => setHidden(true), 700);
    return () => clearTimeout(timer);
  }, [pct]);

  const fill = color === 'sky' ? 'bg-sky-400' : 'bg-amber-400';
  const pctText = color === 'sky' ? 'text-sky-400' : 'text-amber-400';
  return (
    <div className={`space-y-1.5 overflow-hidden transition-all duration-500 ${
      hidden ? 'max-h-0 opacity-0' : 'max-h-16 opacity-100'
    }`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-400">{message}</p>
        <span className={`text-xs ${pctText} tabular-nums shrink-0`}>{pct}%</span>
      </div>
      <div className="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${fill} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function StatusIndicator({ book }: { book: Book }) {
  const [open,     setOpen]     = useState(false);
  const [eta,      setEta]      = useState<string | null>(null);
  const startRef = useRef<{ time: number; done: number } | null>(null);
  const currentIdx = STATUS_ORDER.indexOf(book.status);

  const isOcr   = book.status === 'ocr_processing';
  const ocrDone  = book.progress.current;
  const ocrTotal = book.progress.total;
  const pct      = ocrTotal > 0 ? Math.round((ocrDone / ocrTotal) * 100) : 0;

  useEffect(() => {
    if (isOcr && ocrDone > 0 && !startRef.current) {
      startRef.current = { time: Date.now(), done: ocrDone };
    }
    if (!isOcr) { startRef.current = null; setEta(null); }
  }, [isOcr, ocrDone]);

  useEffect(() => {
    if (!isOcr) return;
    const timer = setInterval(() => {
      if (!startRef.current || ocrDone >= ocrTotal) { setEta(null); return; }
      const elapsed    = (Date.now() - startRef.current.time) / 1000;
      const processed  = ocrDone - startRef.current.done;
      if (processed <= 0) return;
      const remaining  = ((ocrTotal - ocrDone) / processed) * elapsed;
      setEta(remaining < 60 ? t('~{n}s', { n: Math.ceil(remaining) }) : t('~{n}m', { n: Math.ceil(remaining / 60) }));
    }, 3000);
    return () => clearInterval(timer);
  }, [isOcr, ocrDone, ocrTotal]);

  return (
    <div className="card py-3 px-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 shrink-0">
            {book.status !== 'error' && book.status !== 'complete' && (
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
            )}
            {book.status === 'error' && <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />}
            <span className="text-sm text-gray-300">
              {book.status === 'error' ? t('Failed') : STATUS_LABEL[book.status] ?? book.status}
            </span>
          </div>

          {isOcr && ocrTotal > 0 && (
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span className="tabular-nums">{ocrDone}/{ocrTotal}</span>
              <span className="tabular-nums font-medium text-amber-400">{pct}%</span>
              {eta && <span>{t('{eta} left', { eta })}</span>}
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

      {isOcr && ocrTotal > 0 && (
        <div className="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-amber-400 rounded-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

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
        alt={t('Cover')}
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

function EditableTitle({ book }: { book: Book }) {
  const dispatch = useDispatch<AppDispatch>();
  const [editing, setEditing] = useState(false);
  const [value, setValue]     = useState(book.name);

  useEffect(() => { if (!editing) setValue(book.name); }, [book.name, editing]);

  const save = () => {
    setEditing(false);
    const next = value.trim();
    if (next && next !== book.name) dispatch(renameBook({ bookId: book._id, name: next }));
    else setValue(book.name);
  };

  if (editing) {
    return (
      <input
        autoFocus
        className="input w-full text-base font-medium"
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') { setValue(book.name); setEditing(false); }
        }}
        placeholder={t('Book title…')}
      />
    );
  }

  return (
    <button
      className="group/title flex items-center gap-1.5 text-left min-w-0 max-w-full"
      onClick={() => setEditing(true)}
      title={t('Edit title')}
    >
      <span className="text-gray-200 font-medium text-base truncate">{book.name || t('Untitled')}</span>
      <svg className="w-3.5 h-3.5 text-gray-500 opacity-0 group-hover/title:opacity-100 transition-opacity shrink-0"
        fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
      </svg>
    </button>
  );
}

const DOT_CLASS: Record<string, string> = {
  complete:   'bg-green-500',
  generating: 'bg-amber-400 animate-pulse',
  stale:      'bg-amber-400',
  error:      'bg-red-500',
  pending:    'bg-gray-700',
};

const TRACK_LABEL: Record<string, string> = {
  complete:   t('ready'),
  generating: t('rendering…'),
  stale:      t('stale'),
  error:      t('error'),
  pending:    t('pending'),
};

const TRACK_TEXT: Record<string, string> = {
  complete:   'text-green-400',
  generating: 'text-amber-400',
  stale:      'text-amber-400',
  error:      'text-red-400',
  pending:    'text-gray-500',
};

function RegenIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  );
}

function VoiceGenProgress({ book, voice }: { book: Book; voice: string }) {
  const dispatch   = useDispatch<AppDispatch>();
  const label      = useVoiceLabel([voice]);
  const statuses   = book.chapters.map(c => trackFor(c, voice)?.audioStatus ?? 'pending');
  const total      = statuses.length;
  const done       = statuses.filter(s => s === 'complete').length;
  const generating = statuses.some(s => s === 'generating');
  const errored    = statuses.some(s => s === 'error');
  const allDone    = total > 0 && done === total;
  const live       = generating ? book.voiceProgress?.[voice] : undefined;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${
            generating ? 'bg-amber-400 animate-pulse' : allDone ? 'bg-green-500' : errored ? 'bg-red-500' : 'bg-gray-700'
          }`} />
          <span className="text-gray-100 font-medium truncate">{label(voice)}</span>
          <span className={`text-xs shrink-0 ${generating ? 'text-amber-400' : allDone ? 'text-green-400' : errored ? 'text-red-400' : 'text-gray-500'}`}>
            {generating ? t('generating…') : allDone ? t('done') : errored ? t('failed') : t('waiting')}
          </span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-gray-500 tabular-nums">{done}/{total}</span>
          <button
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-amber-400 disabled:opacity-40 disabled:hover:text-gray-400 transition-colors"
            disabled={generating}
            onClick={() => dispatch(regenerateVoice({ bookId: book._id, voice })).unwrap().catch(e => alert(e.message))}
            title={t('Regenerate this voice for every chapter')}
          >
            <RegenIcon /> {t('Regenerate')}
          </button>
        </span>
      </div>

      {live && live.total > 0 && (
        <div className="px-3 pb-2 space-y-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-gray-400 truncate">{live.message}</p>
            <span className="text-xs text-amber-400 tabular-nums shrink-0">
              {live.current}/{live.total} · {Math.min(100, Math.round((live.current / live.total) * 100))}%
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
            <div
              className="h-full bg-amber-400 rounded-full transition-all duration-500"
              style={{ width: `${Math.min(100, (live.current / live.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className="border-t border-gray-800 divide-y divide-gray-800/60 max-h-56 overflow-y-auto">
        {book.chapters.map((c, i) => {
          const s = statuses[i];
          const err = s === 'error' ? trackFor(c, voice)?.audioError : undefined;
          return (
            <div key={c._id} className="px-3 py-1.5">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${DOT_CLASS[s] ?? 'bg-gray-700'}`} />
                <span className="text-gray-500 text-xs tabular-nums shrink-0 w-5">{i + 1}.</span>
                <span className={`text-sm truncate flex-1 ${s === 'generating' ? 'text-amber-300' : 'text-gray-300'}`}>
                  {c.title || t('Chapter {n}', { n: i + 1 })}
                </span>
                <span className={`text-[11px] shrink-0 ${TRACK_TEXT[s] ?? 'text-gray-500'}`}>
                  {TRACK_LABEL[s] ?? s}
                </span>
                {s === 'error' && (
                  <button
                    className="text-[11px] font-medium text-amber-400 hover:text-amber-300 transition-colors shrink-0"
                    onClick={() => dispatch(continueChapterVoice({ bookId: book._id, chapterIdx: i, voice })).unwrap().catch(e => alert(e.message))}
                    title={t('Continue this chapter — keep finished sentences, render only what failed')}
                  >
                    {t('Continue')}
                  </button>
                )}
                <button
                  className="text-gray-600 hover:text-amber-400 disabled:opacity-30 disabled:hover:text-gray-600 transition-colors shrink-0"
                  disabled={s === 'generating'}
                  onClick={() => dispatch(regenerateChapterVoice({ bookId: book._id, chapterIdx: i, voice })).unwrap().catch(e => alert(e.message))}
                  title={t('Regenerate this chapter from scratch for this voice')}
                >
                  <RegenIcon className="w-3 h-3" />
                </button>
              </div>
              {err && <p className="text-[11px] text-red-400/90 pl-9 mt-0.5 break-words">{err}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function EditBookPage() {
  const { id }   = useParams<{ id: string }>();
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const book     = useSelector((s: RootState) => s.books.books.find(b => b._id === id));
  const canDelete = useSelector((s: RootState) => s.books.canDelete);

  const [showCoverPicker,  setShowCoverPicker]  = useState(false);
  const [showVoiceDialog,  setShowVoiceDialog]  = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [generating,       setGenerating]       = useState(false);
  const [showReimport,     setShowReimport]      = useState(false);
  const [resuming,         setResuming]         = useState(false);
  const [dismissing,       setDismissing]       = useState(false);
  const [stopping,         setStopping]         = useState(false);
  const chapterReviewRef = useRef<ChapterReviewHandle>(null);
  const textReviewRef = useRef<TextReviewHandle>(null);
  const generatedRef = useRef(false);
  const voiceRef = useRef<string[] | undefined>(undefined);

  useEffect(() => { if (id) requestBook(id); }, [id]);

  useEffect(() => {
    if (book?.status === 'complete' && generatedRef.current) {
      generatedRef.current = false;
      navigate(`/books/${id}`);
    }
  }, [book?.status, id, navigate]);

  if (!book) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-gray-500">{t('Loading…')}</p></div>;
  }

  const backTo = book.status === 'complete' ? `/books/${book._id}` : '/';

  const handleDelete = async () => {
    setShowDeleteConfirm(false);
    await dispatch(deleteBook(id!)).unwrap();
    navigate('/');
  };

  const handleConfirmChapters = async (chapters: { title: string; startPage: number; startChar: number }[]) => {
    await dispatch(confirmChapters({ bookId: id!, chapters, voices: voiceRef.current })).unwrap();
  };

  const runGenerate = async (voices?: string[]) => {
    setShowVoiceDialog(false);
    setGenerating(true);
    generatedRef.current = true;
    try {
      if (voices && voices.length) {
        voiceRef.current = voices;
        await chapterReviewRef.current?.submit();
      } else {
        await chapterReviewRef.current?.save();
        await dispatch(generateBook(id!)).unwrap();
      }
    } finally { setGenerating(false); }
  };

  const handleStop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await dispatch(stopBook(book._id)).unwrap();
    } catch { /* nothing running */ } finally {
      setStopping(false);
    }
  };

  const importBusy = resuming || dismissing;

  const handleResume = async () => {
    if (importBusy) return;
    setResuming(true);
    try {
      await dispatch(resumeBook(book._id)).unwrap();
    } finally {
      setResuming(false);
    }
  };

  const handleDismissError = async () => {
    if (importBusy) return;
    setDismissing(true);
    try {
      await dispatch(dismissBookError(book._id)).unwrap();
    } finally {
      setDismissing(false);
    }
  };

  const hasOcrPages   = book.ocrPages.length > 0;
  const hasChapters   = book.chapters.length > 0;
  const failedPages   = book.ocrPages.filter(p => p.status === 'error').length;
  // Offer a one-click restart (reusing the stored PDF + page settings) whenever
  // a run failed or finished with some pages unreadable.
  const canReprocess  = book.status === 'error' || failedPages > 0;
  // A newly added voice renders in the background while the book stays 'complete'
  // (so it remains listenable) — treat an actively-rendering track as generation so
  // the progress section shows. Only 'generating' counts: leftover 'pending'/'stale'
  // tracks from an interrupted run mean nothing is running (offer Continue instead).
  const voiceRendering = book.status === 'complete'
    && book.chapters.some(c => c.tracks?.some(t => t.audioStatus === 'generating'));
  const isGenerating  = book.status === 'generating_audio'
    || book.chapters.some(c => chapterStatus(c) === 'generating')
    || voiceRendering;
  const hasAudioError = book.chapters.some(c => chapterStatus(c) === 'error');
  const showStatus    = book.status !== 'complete' && book.status !== 'error' && !isGenerating;
  const showGenerate  = (book.status === 'awaiting_chapter_review' || book.status === 'complete' || book.status === 'error') && !isGenerating;
  const hasStaleAudio = book.chapters.some(c => chapterStatus(c) === 'stale');
  const canListenNow  = isGenerating && hasPlayableAudio(book);

  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur sticky top-0 z-10">
        <div className="w-[min(64rem,95vw)] mx-auto px-6 py-4 flex items-center gap-4">
          <button className="text-gray-500 hover:text-gray-300 transition-colors" onClick={() => navigate(backTo)}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            className="text-lg font-semibold text-gray-100 flex-1 truncate text-left hover:text-gray-300 transition-colors"
            onClick={() => navigate(backTo)}
          >
            {book.name || t('Untitled')}
          </button>
          {canListenNow && (
            <button
              className="text-gray-500 hover:text-emerald-400 transition-colors"
              aria-label={t('Start listening to ready chapters')}
              onClick={() => navigate(`/books/${book._id}`)}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
          )}
          {canDelete && (
          <button
            className="text-gray-500 hover:text-red-400 transition-colors"
            aria-label={t('Delete book')}
            onClick={() => setShowDeleteConfirm(true)}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
          )}
        </div>
      </header>

      <main className="w-[min(64rem,95vw)] mx-auto px-6 py-6 space-y-5">

        <div className="card flex gap-5 items-start">
          <EditableCover bookId={book._id} coverVersion={book.coverVersion ?? 0} onClick={() => setShowCoverPicker(true)} size="md" />
          <div className="space-y-2 text-sm text-gray-400 min-w-0 flex-1">
            <EditableTitle book={book} />
            {book.totalPages > 0 && <p>{t('{n} pages', { n: book.totalPages })}</p>}
            {(book.status === 'complete' || book.status === 'generating_audio') && (
              <VoiceManager book={book} editable={book.status === 'complete'} allowModify />
            )}
          </div>
        </div>

        {showStatus && <StatusIndicator book={book} />}

        {book.status === 'error' && (
          <div className="card border-red-800 bg-red-950/20">
            <p className="text-red-400 font-medium mb-1">{t('Processing failed')}</p>
            <p className="text-sm text-red-300">{book.errorMessage}</p>
          </div>
        )}

        {canReprocess && (
          <div className="card flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm text-gray-400">
              {book.status === 'error'
                ? t('Import failed. Restart it using the same pages you already set.')
                : failedPages === 1
                  ? t('{n} page failed to read. Restart the import with the same settings.', { n: failedPages })
                  : t('{n} pages failed to read. Restart the import with the same settings.', { n: failedPages })}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button className="btn-secondary" onClick={handleResume} disabled={importBusy}>
                {resuming ? t('Resuming…') : t('Continue importing')}
              </button>
              <button className="btn-secondary" onClick={() => setShowReimport(true)} disabled={importBusy}>
                {t('Restart import')}
              </button>
              <button className="btn-secondary" onClick={handleDismissError} disabled={importBusy}>
                {dismissing ? t('Discarding…') : t('Discard error')}
              </button>
            </div>
          </div>
        )}

        {hasChapters && (
          <>
            <div className="card">
              <ChapterReview
                ref={chapterReviewRef}
                book={book}
                onConfirm={handleConfirmChapters}
                onOpenPage={hasOcrPages ? (page => textReviewRef.current?.openAt(page)) : undefined}
              />
            </div>

          </>
        )}

        {hasOcrPages && <TextReview ref={textReviewRef} bookId={book._id} ocrPages={book.ocrPages} />}

        {hasChapters && (isGenerating || hasAudioError) && (
          <div className="card space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold text-gray-100">{isGenerating ? t('Generating audio') : t('Generation results')}</h3>
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500 hidden sm:inline">
                  {t('green = ready · pulsing = rendering · red = failed')}
                </span>
                {isGenerating && (
                  <button
                    className="flex items-center gap-1.5 text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-40 disabled:hover:text-red-400 transition-colors shrink-0"
                    disabled={stopping}
                    onClick={handleStop}
                    title={t('Stop generating — keep chapters already rendered')}
                  >
                    <span className="w-2.5 h-2.5 rounded-sm bg-current" />
                    {stopping ? t('Stopping…') : t('Stop')}
                  </button>
                )}
              </div>
            </div>
            {/* While voices render concurrently each card shows its own live
                bar — the single global bar would just flip between lanes. */}
            {book.progress.message && book.progress.total > 0 && !Object.keys(book.voiceProgress ?? {}).length && (
              <AutoHideBar
                current={book.progress.current}
                total={book.progress.total}
                message={book.progress.message}
                color="amber"
              />
            )}
            {book.progress.message && book.progress.total === 0 && (
              <p className="text-sm text-gray-400">{book.progress.message}</p>
            )}
            {book.splitProgress && book.splitProgress.total > 0 && (
              <AutoHideBar
                current={book.splitProgress.current}
                total={book.splitProgress.total}
                message={`${book.splitProgress.message} (${book.splitProgress.current}/${book.splitProgress.total})`}
                color="sky"
              />
            )}
            {bookVoices(book).map(voice => (
              <VoiceGenProgress key={voice} book={book} voice={voice} />
            ))}
          </div>
        )}

        {hasChapters && showGenerate && (
          <div className="space-y-3">
            {hasStaleAudio && !isGenerating && (
              <div className="flex items-start gap-3 rounded-lg border border-amber-700 bg-amber-950/30 px-4 py-3">
                <svg className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <p className="text-sm text-amber-300">
                  {t('Audio generation is incomplete or out of date. Click')} <strong>{t('Continue')}</strong> {t('to resume — finished chapters are kept and only the rest are rendered.')}
                </p>
              </div>
            )}
            <button
              className="btn-primary w-full justify-center"
              disabled={generating}
              onClick={() => book.status === 'complete' || book.status === 'error' ? runGenerate() : setShowVoiceDialog(true)}
            >
              {generating ? t('Generating…') : hasStaleAudio ? t('Continue') : book.status === 'error' ? t('Retry') : t('Generate')}
            </button>
          </div>
        )}

      </main>

      {showCoverPicker && (
        <CoverPickerModal book={book} onClose={() => setShowCoverPicker(false)} />
      )}

      {showVoiceDialog && (
        <GenerateVoiceModal
          bookId={book._id}
          initialVoice={bookVoices(book)[0]}
          onConfirm={runGenerate}
          onClose={() => setShowVoiceDialog(false)}
        />
      )}

      {showDeleteConfirm && (
        <ConfirmDialog
          title={t('Delete book?')}
          message={t('"{name}" and all its audio will be permanently deleted.', { name: book.name || t('Untitled') })}
          confirmLabel={t('Delete')}
          danger
          onConfirm={handleDelete}
          onClose={() => setShowDeleteConfirm(false)}
        />
      )}

      {showReimport && (
        <ReimportModal book={book} onClose={() => setShowReimport(false)} />
      )}
    </div>
  );
}
