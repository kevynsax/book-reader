import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
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

interface LineOccurrence {
  pageIdx: number;
  page: number;
  lineIdx: number;
}

interface PageViewProps {
  bookId: string;
  page: OcrPage;
  large?: boolean;
  /** When set, the image is shown via the zoom/pan PagePreview instead of a plain <img>. */
  preview?: PreviewNav;
  /** When set, the text panel becomes an auto-saving textarea. */
  edit?: {
    draft: string;
    onChange: (text: string) => void;
    onBlur: () => void;
    onUndo: () => void;
    warnOver: number;
    activeLine: number | null;
  };
}

// Find the first matching character between the target min/max positions.
function scanFor(line: string, char: string, from: number, to: number): number {
  const start = Math.max(0, from);
  const end = Math.min(line.length - 1, to);
  for (let i = start; i <= end; i++) if (line[i] === char) return i;
  return -1;
}

// If no target-window break exists, use the nearest earlier preferred break.
function scanBefore(line: string, char: string, before: number): number {
  const start = Math.min(line.length - 1, before - 1);
  for (let i = start; i >= 0; i--) if (line[i] === char) return i;
  return -1;
}

function scanNearest(line: string, char: string, target: number): number {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== char) continue;
    const distance = Math.abs(i - target);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

function splitAt(line: string, at: number): [string, string] | null {
  const left = line.slice(0, at + 1).replace(/\s+$/, '');
  const right = line.slice(at + 1).replace(/^\s+/, '');
  return left === '' || right === '' ? null : [left, right];
}

function isSmallLargeSplit(left: string, right: string, minLen: number, maxLen: number): boolean {
  return (left.length < minLen && right.length > maxLen) || (right.length < minLen && left.length > maxLen);
}

function middleSplit(line: string): [string, string] | null {
  const target = Math.floor(line.length / 2);
  let at = scanNearest(line, ';', target);
  if (at === -1) at = scanNearest(line, ':', target);
  if (at === -1) at = scanNearest(line, ',', target);
  return at === -1 ? null : splitAt(line, at);
}

// Break the first line longer than `maxLen`, preferring ; then : then ,
// between minLen and maxLen, then falling back before minLen. Returns null if
// nothing was broken.
function breakLineAt(lines: string[], lineIdx: number, minLen: number, maxLen: number): string[] | null {
  const line = lines[lineIdx];
  if (!line || line.length <= maxLen) return null;
  let at = scanFor(line, ';', minLen, maxLen);
  if (at === -1) at = scanFor(line, ':', minLen, maxLen);
  if (at === -1) at = scanFor(line, ',', minLen, maxLen);
  if (at === -1) at = scanBefore(line, ';', minLen);
  if (at === -1) at = scanBefore(line, ':', minLen);
  if (at === -1) at = scanBefore(line, ',', minLen);
  if (at === -1) return null;
  let split = splitAt(line, at);
  if (!split) return null;
  if (isSmallLargeSplit(split[0], split[1], minLen, maxLen)) split = middleSplit(line) ?? split;
  const [left, right] = split;
  const next = lines.slice();
  next.splice(lineIdx, 1, left, right);
  return next;
}

function breakLongLine(text: string, minLen: number, maxLen: number, preferredLine?: number): string | null {
  const lines = text.split('\n');
  if (preferredLine !== undefined) {
    const preferred = breakLineAt(lines, preferredLine, minLen, maxLen);
    if (preferred) return preferred.join('\n');
  }
  for (let i = 0; i < lines.length; i++) {
    const next = breakLineAt(lines, i, minLen, maxLen);
    if (next) return next.join('\n');
  }
  return null;
}

// An auto-saving editor whose lines longer than `warnOver` get a light warning
// background. A plain <textarea> can't style individual lines, so a synced
// highlight backdrop sits behind a transparent-background textarea.
function HighlightEditor(
  { draft, onChange, onBlur, onUndo, warnOver, activeLine }: NonNullable<PageViewProps['edit']>,
) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lines = draft.split('\n');
  const shared = 'p-0 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words';

  useEffect(() => {
    if (activeLine === null) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 18;
    textarea.scrollTop = Math.max(0, activeLine * lineHeight - textarea.clientHeight / 3);
    if (backdropRef.current) backdropRef.current.scrollTop = textarea.scrollTop;
  }, [activeLine, draft]);

  return (
    <div className="relative flex-1 min-h-[60vh]">
      <div
        ref={backdropRef}
        aria-hidden
        className={`absolute inset-0 overflow-hidden pointer-events-none text-transparent ${shared}`}
      >
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              i === activeLine
                ? 'bg-amber-500/35 outline outline-1 outline-amber-400/50 rounded-sm'
                : line.length > warnOver ? 'bg-amber-500/15 rounded-sm' : ''
            }
          >
            {line.length ? line : ' '}
          </div>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        autoFocus
        spellCheck={false}
        className={`absolute inset-0 w-full h-full overflow-auto bg-transparent text-gray-200 resize-none outline-none ${shared}`}
        value={draft}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            onUndo();
          }
        }}
        onBlur={onBlur}
        onScroll={e => {
          const el = backdropRef.current;
          if (el) { el.scrollTop = e.currentTarget.scrollTop; el.scrollLeft = e.currentTarget.scrollLeft; }
        }}
      />
    </div>
  );
}

function PageView({ bookId, page, large, preview, edit }: PageViewProps) {
  return (
    <div
      className={`grid gap-4 ${
        large
          ? 'h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:grid-rows-1'
          : 'grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]'
      }`}
    >
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
            <HighlightEditor {...edit} />
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
  const [minLen,     setMinLen]     = useState(120);
  const [maxLen,     setMaxLen]     = useState(180);
  const [showSaved,  setShowSaved]  = useState(false);
  const [activeReview, setActiveReview] = useState<LineOccurrence | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  const undoStack = useRef<string[]>([]);

  const flashSaved = useCallback(() => {
    setShowSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setShowSaved(false), 1500);
  }, []);

  useEffect(() => () => clearTimeout(savedTimer.current), []);

  useEffect(() => {
    if (!userMoved && processed.length > 0) setIdx(processed.length - 1);
  }, [processed.length, userMoved]);

  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', handler);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = prevOverflow;
    };
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

  const reviewOccurrences = useMemo<LineOccurrence[]>(() => {
    const items: LineOccurrence[] = [];
    processed.forEach((p, pageIdx) => {
      const text = pageIdx === safeIdx ? draft : (p.text ?? '');
      text.split('\n').forEach((line, lineIdx) => {
        if (line.length > maxLen) items.push({ pageIdx, page: p.page, lineIdx });
      });
    });
    return items;
  }, [processed, safeIdx, draft, maxLen]);

  const activeReviewIndex = activeReview
    ? reviewOccurrences.findIndex(o => o.page === activeReview.page && o.lineIdx === activeReview.lineIdx)
    : -1;

  useEffect(() => {
    if (!activeReview) return;
    if (activeReviewIndex === -1) setActiveReview(null);
  }, [activeReview, activeReviewIndex]);

  // Keep the editor draft in sync with the page being shown.
  useEffect(() => {
    setDraft(page?.text ?? '');
    undoStack.current = [];
  }, [page?.page, fullscreen]);

  if (processed.length === 0) return null;

  const minPage = processed[0].page;
  const maxPage = processed[processed.length - 1].page;
  const prev = () => { setUserMoved(true); setIdx(i => Math.max(0, i - 1)); };
  const next = () => { setUserMoved(true); setIdx(i => Math.min(processed.length - 1, i + 1)); };

  const saveDraft = () => {
    if (draft !== (page.text ?? '')) {
      dispatch(updatePageText({ bookId, page: page.page, text: draft }));
      flashSaved();
    }
  };

  const changeDraft = (next: string) => {
    setDraft(prev => {
      if (next === prev) return prev;
      undoStack.current.push(prev);
      if (undoStack.current.length > 100) undoStack.current.shift();
      return next;
    });
  };

  const undoDraft = () => {
    const prev = undoStack.current.pop();
    if (prev === undefined) return;
    setDraft(prev);
  };

  const goToReview = (occurrence: LineOccurrence) => {
    saveDraft();
    const target = processed[occurrence.pageIdx];
    setDraft(target?.text ?? '');
    undoStack.current = [];
    setUserMoved(true);
    setIdx(occurrence.pageIdx);
    setActiveReview(occurrence);
  };

  const nextReview = () => {
    if (reviewOccurrences.length === 0) return;
    const currentLine = activeReview?.page === page.page ? activeReview.lineIdx : -1;
    const nextOccurrence = reviewOccurrences.find(o =>
      o.pageIdx > safeIdx || (o.pageIdx === safeIdx && o.lineIdx > currentLine),
    ) ?? reviewOccurrences[0];
    goToReview(nextOccurrence);
  };

  const prevReview = () => {
    if (reviewOccurrences.length === 0) return;
    const currentLine = activeReview?.page === page.page ? activeReview.lineIdx : Number.MAX_SAFE_INTEGER;
    const previous = reviewOccurrences.filter(o =>
      o.pageIdx < safeIdx || (o.pageIdx === safeIdx && o.lineIdx < currentLine),
    );
    goToReview(previous[previous.length - 1] ?? reviewOccurrences[reviewOccurrences.length - 1]);
  };

  const breakLine = () => {
    const reviewLine = activeReview?.page === page.page ? activeReview.lineIdx : undefined;
    const result = breakLongLine(draft, minLen, maxLen, reviewLine);
    if (result === null) return;
    changeDraft(result);
    dispatch(updatePageText({ bookId, page: page.page, text: result }));
    flashSaved();
    setActiveReview(null);
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

      {fullscreen && createPortal(
        <div className="fixed inset-0 z-50 h-[100dvh] w-screen bg-gray-950 flex flex-col">
          <div className="relative flex items-center gap-4 px-6 py-4 border-b border-gray-800 shrink-0">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <h2 className="font-semibold text-gray-100">Reading pages</h2>
              <p className="text-xs text-gray-500">
                {done} of {total} pages
                {current && <span className="text-amber-400 ml-1">· reading page {current.page}…</span>}
              </p>
              {showSaved && (
                <span className="flex items-center gap-1 text-xs text-emerald-400 shrink-0">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Saved
                </span>
              )}
            </div>

            {/* Page label centered in the header */}
            <span className="absolute left-1/2 -translate-x-1/2 font-mono text-sm text-gray-200">
              P. {page.page}
            </span>

            <div className="flex items-center gap-2 shrink-0">
              <div className="flex items-center gap-1 rounded border border-gray-800 bg-gray-900 px-1.5 py-1">
                <span className="px-1 text-[11px] text-gray-400 tabular-nums">
                  {reviewOccurrences.length === 0
                    ? '0 issues'
                    : `${activeReviewIndex >= 0 ? activeReviewIndex + 1 : '-'} / ${reviewOccurrences.length}`}
                </span>
                <button
                  className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
                  onClick={prevReview}
                  disabled={reviewOccurrences.length === 0}
                  title="Previous long line"
                  aria-label="Previous long line"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 15l-6-6-6 6" />
                  </svg>
                </button>
                <button
                  className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
                  onClick={nextReview}
                  disabled={reviewOccurrences.length === 0}
                  title="Next long line"
                  aria-label="Next long line"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              </div>
              <input
                type="number"
                value={minLen}
                onChange={e => setMinLen(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-14 h-7 px-1 text-center text-xs bg-gray-800 border border-gray-700 rounded text-gray-200 outline-none focus:border-gray-500"
                title="Min line length — don't break before this many characters"
              />
              <span className="text-gray-600 text-xs">–</span>
              <input
                type="number"
                value={maxLen}
                onChange={e => setMaxLen(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-14 h-7 px-1 text-center text-xs bg-gray-800 border border-gray-700 rounded text-gray-200 outline-none focus:border-gray-500"
                title="Max line length — longer lines are flagged and scanned for a break point"
              />
              <button
                className="w-8 h-8 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
                onClick={breakLine}
                title="Break the first long line at the next ; : or ,"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
                </svg>
              </button>
            </div>

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

          <div className="flex-1 min-h-0 p-3 sm:p-4">
            <PageView
              bookId={bookId}
              page={page}
              large
              preview={{ totalPages: maxPage, minPage, onPageChange: (p) => { saveDraft(); goToPage(p); } }}
              edit={{
                draft,
                onChange: changeDraft,
                onBlur: saveDraft,
                onUndo: undoDraft,
                warnOver: maxLen,
                activeLine: activeReview?.page === page.page ? activeReview.lineIdx : null,
              }}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
});

export default TextReview;
