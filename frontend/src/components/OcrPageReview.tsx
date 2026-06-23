import { useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../store';
import { updatePageText } from '../store/booksSlice';
import { OcrPage } from '../types';
import { diffText } from '../lib/diff';
import PagePreview from './PagePreview';

// Render the reviewed text, highlighting spans that get rewritten for speech.
// Hovering a highlight instantly reveals what will actually be read (a custom
// portal tooltip — the native `title` delay is too slow, and a portal avoids the
// scroll panel clipping it).
function ReadDiff({ text, read }: { text: string; read?: string }) {
  const segs = useMemo(
    () => (read && read !== text ? diffText(text, read) : null),
    [text, read],
  );
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  const base = 'font-mono text-xs leading-relaxed text-gray-200 whitespace-pre-wrap';
  if (!segs) return <p className={base}>{text}</p>;

  const show = (e: React.MouseEvent, spoken: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ text: spoken, x: r.left + r.width / 2, y: r.top });
  };

  return (
    <>
      <p className={base}>
        {segs.map((s, i) => {
          if (s.read === null) return <span key={i}>{s.text}</span>;
          const spoken = s.read.trim() || 'omitted when read';
          const cls = s.text === ''
            ? 'bg-emerald-600/30 text-emerald-200 rounded-sm px-0.5 cursor-help'
            : 'bg-amber-500/25 text-amber-200 rounded-sm cursor-help';
          return (
            <mark
              key={i}
              className={cls}
              onMouseEnter={e => show(e, spoken)}
              onMouseLeave={() => setTip(null)}
            >
              {s.text === '' ? '＋' : s.text}
            </mark>
          );
        })}
      </p>
      {tip && createPortal(
        <div
          className="fixed z-50 -translate-x-1/2 -translate-y-full -mt-1 pointer-events-none max-w-xs
                     rounded border border-gray-700 bg-gray-950 px-2 py-1 text-[11px] text-gray-100
                     shadow-lg whitespace-normal break-words"
          style={{ left: tip.x, top: tip.y }}
        >
          {tip.text}
        </div>,
        document.body,
      )}
    </>
  );
}

interface Props {
  bookId: string;
  ocrPages: OcrPage[];
}

export interface TextReviewHandle {
  /** Open the fullscreen editor on the given (or nearest processed) page. */
  openAt: (page: number) => void;
}

interface PreviewNav {
  totalPages: number;
  minPage: number;
  onPageChange: (page: number) => void;
}

interface PageViewProps {
  bookId: string;
  page: OcrPage;
  large?: boolean;
  /** When set, the image is shown via the zoom/pan PagePreview instead of a plain <img>. */
  preview?: PreviewNav;
  /** When set, the text panel becomes an auto-saving textarea. */
  edit?: { draft: string; onChange: (text: string) => void; onBlur: () => void };
}

function PageView({ bookId, page, large, preview, edit }: PageViewProps) {
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-4 ${large ? 'h-full min-h-0 grid-rows-1' : ''}`}>
      {preview ? (
        <div className="min-h-0">
          <PagePreview
            bookId={bookId}
            page={page.page}
            totalPages={preview.totalPages}
            minPage={preview.minPage}
            onPageChange={preview.onPageChange}
          />
        </div>
      ) : (
        <div className="bg-gray-800 rounded-lg overflow-hidden">
          <img
            key={page.page}
            src={`/api/books/${bookId}/pages/${page.page}`}
            alt={`Page ${page.page}`}
            className={`w-full block object-contain ${large ? 'h-[calc(100vh-10rem)]' : 'h-auto'}`}
            loading="lazy"
          />
        </div>
      )}
      <div className={`bg-gray-800/50 rounded-lg p-3 overflow-y-auto min-h-0 ${large ? '' : 'max-h-[70vh]'}`}>
        {edit ? (
          <div className="flex flex-col h-full min-h-0">
            <p className="text-[11px] text-gray-500 mb-2 shrink-0">
              One sentence per line · blank line separates paragraphs
            </p>
            <textarea
              autoFocus
              className="w-full flex-1 min-h-[60vh] bg-transparent font-mono text-xs leading-relaxed text-gray-200 resize-none outline-none"
              value={edit.draft}
              onChange={e => edit.onChange(e.target.value)}
              onBlur={edit.onBlur}
            />
          </div>
        ) : page.status === 'processing' ? (
          <span className="text-xs text-amber-400 animate-pulse">Reading page…</span>
        ) : page.text?.trim() ? (
          <ReadDiff text={page.text} read={page.readText} />
        ) : (
          <span className="text-xs text-gray-500">No text extracted for this page</span>
        )}
      </div>
    </div>
  );
}

const TextReview = forwardRef<TextReviewHandle, Props>(function TextReview({ bookId, ocrPages }, ref) {
  const dispatch = useDispatch<AppDispatch>();
  const processed = ocrPages.filter(p => p.status === 'complete' || p.status === 'processing');
  const done      = ocrPages.filter(p => p.status === 'complete').length;
  const total     = ocrPages.length;
  const current   = ocrPages.find(p => p.status === 'processing');

  const [idx,        setIdx]        = useState(0);
  const [userMoved,  setUserMoved]  = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [draft,      setDraft]      = useState('');

  useEffect(() => {
    if (!userMoved && processed.length > 0) setIdx(processed.length - 1);
  }, [processed.length, userMoved]);

  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fullscreen]);

  // Jump to the processed page whose number is closest to the requested one.
  const goToPage = useCallback((target: number) => {
    if (processed.length === 0) return;
    let best = 0, bestDiff = Infinity;
    processed.forEach((p, i) => {
      const d = Math.abs(p.page - target);
      if (d < bestDiff) { bestDiff = d; best = i; }
    });
    setUserMoved(true);
    setIdx(best);
  }, [processed]);

  useImperativeHandle(ref, () => ({
    openAt: (page: number) => { goToPage(page); setFullscreen(true); },
  }), [goToPage]);

  const safeIdx = Math.min(idx, Math.max(0, processed.length - 1));
  const page    = processed[safeIdx];

  // Keep the editor draft in sync with the page being shown.
  useEffect(() => { setDraft(page?.text ?? ''); }, [page?.page, page?.text, fullscreen]);

  if (processed.length === 0) return null;

  const minPage = processed[0].page;
  const maxPage = processed[processed.length - 1].page;
  const prev = () => { setUserMoved(true); setIdx(i => Math.max(0, i - 1)); };
  const next = () => { setUserMoved(true); setIdx(i => Math.min(processed.length - 1, i + 1)); };

  const saveDraft = () => {
    if (draft !== (page.text ?? '')) {
      dispatch(updatePageText({ bookId, page: page.page, text: draft }));
    }
  };

  const Nav = () => (
    <div className="flex items-center gap-1 shrink-0">
      <button
        className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
        onClick={prev} disabled={safeIdx === 0}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <button
        className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
        onClick={next} disabled={safeIdx === processed.length - 1}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );

  return (
    <>
      <div className="card space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h3 className="font-semibold text-gray-100 shrink-0">Reading pages</h3>
          <div className="flex items-center gap-2">
            {processed.length > 1 && <Nav />}
            <button
              className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
              onClick={() => setFullscreen(true)}
              title="Edit"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          </div>
        </div>

        <p className="text-xs text-gray-500">
          {done} of {total} pages processed
          {current && <span className="text-amber-400"> · reading page {current.page}…</span>}
        </p>

        {/* Page label, centered above the image/text area */}
        <div className="text-center font-mono text-sm text-gray-300">
          P. {page.page}
          <span className="text-gray-500"> · {safeIdx + 1}/{processed.length}</span>
        </div>

        <PageView bookId={bookId} page={page} />
      </div>

      {fullscreen && (
        <div className="fixed inset-0 z-50 bg-gray-950/95 backdrop-blur flex flex-col">
          <div className="relative flex items-center gap-4 px-6 py-4 border-b border-gray-800 shrink-0">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <h2 className="font-semibold text-gray-100">Reading pages</h2>
              <p className="text-xs text-gray-500">
                {done} of {total} pages
                {current && <span className="text-amber-400 ml-1">· reading page {current.page}…</span>}
              </p>
            </div>

            {/* Page label centered in the header */}
            <span className="absolute left-1/2 -translate-x-1/2 font-mono text-sm text-gray-200">
              P. {page.page}
            </span>

            <button
              className="w-8 h-8 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors shrink-0"
              onClick={() => { saveDraft(); setFullscreen(false); }}
              title="Close (Esc)"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex-1 min-h-0 px-6 py-4">
            <PageView
              bookId={bookId}
              page={page}
              large
              preview={{ totalPages: maxPage, minPage, onPageChange: (p) => { saveDraft(); goToPage(p); } }}
              edit={{ draft, onChange: setDraft, onBlur: saveDraft }}
            />
          </div>
        </div>
      )}
    </>
  );
});

export default TextReview;
