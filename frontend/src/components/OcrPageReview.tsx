import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../store';
import { updatePageText } from '../store/booksSlice';
import { OcrPage } from '../types';
import { diffText } from '../lib/diff';
import { api } from '../api/booksApi';
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
  kind: 'long' | 'typo';
  suggestion?: string;
}

interface TypoFinding {
  page: number;
  lineIdx: number;
  original: string;
  corrected: string;
}

// A single word-level change within a line's correction. Each one is reviewed
// and approved independently, so one line with two typos yields two items.
interface TypoChange {
  pageIdx: number;
  page: number;
  lineIdx: number;
  original: string;
  corrected: string;
  segIdx: number;
  oldSeg: string;
  newSeg: string;
}

function deriveTypoChanges(
  findings: TypoFinding[],
  processed: OcrPage[],
  currentIdx: number,
  currentDraft: string,
): TypoChange[] {
  const items: TypoChange[] = [];
  processed.forEach((p, pageIdx) => {
    const lines = (pageIdx === currentIdx ? currentDraft : (p.text ?? '')).split('\n');
    findings.filter(t => t.page === p.page).forEach(t => {
      if (lines[t.lineIdx] !== t.original) return;
      diffText(t.original, t.corrected).forEach((seg, segIdx) => {
        if (seg.read === null) return;
        if (seg.text.trim() === '' && seg.read.trim() === '') return;
        items.push({
          pageIdx, page: p.page, lineIdx: t.lineIdx,
          original: t.original, corrected: t.corrected,
          segIdx, oldSeg: seg.text, newSeg: seg.read,
        });
      });
    });
  });
  return items.sort((a, b) => a.pageIdx - b.pageIdx || a.lineIdx - b.lineIdx || a.segIdx - b.segIdx);
}

// Apply only the change at `segIdx` to `original`, leaving the line's other
// pending changes as-is.
function applyTypoChange(original: string, corrected: string, segIdx: number): string {
  return diffText(original, corrected)
    .map((seg, idx) => (seg.read === null ? seg.text : idx === segIdx ? seg.read : seg.text))
    .join('');
}

// New corrected target with the change at `segIdx` discarded (reverted to the
// original) while the line's other pending corrections remain.
function discardTypoChange(original: string, corrected: string, segIdx: number): string {
  return diffText(original, corrected)
    .map((seg, idx) => (seg.read === null ? seg.text : idx === segIdx ? seg.text : seg.read))
    .join('');
}

// The 3 words immediately before and after a change segment, taken from the
// original line, so the reviewer sees the change in context.
function segContext(original: string, corrected: string, segIdx: number): { before: string; after: string } {
  const segs = diffText(original, corrected);
  const before = segs.slice(0, segIdx).map(s => s.text).join('').split(/\s+/).filter(Boolean).slice(-3).join(' ');
  const after = segs.slice(segIdx + 1).map(s => s.text).join('').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  return { before, after };
}

async function runPool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) await worker(items[cursor++]);
  });
  await Promise.all(runners);
}

interface SplitProposal {
  original: string;
  left: string;
  right: string;
}

type SplitStrategy = 'punctuation' | 'conjunction' | 'slm';

const SPLIT_STRATEGIES: SplitStrategy[] = ['punctuation', 'conjunction', 'slm'];
const SLM_MODEL_SESSION_KEY = 'book-reader:line-review-slm-model';
const REVIEW_MODEL_SESSION_KEY = 'book-reader:reading-review-model';

function storedReviewModel(): string {
  if (typeof window === 'undefined') return '';
  return sessionStorage.getItem(REVIEW_MODEL_SESSION_KEY)?.trim() || '';
}

function prettyModel(id: string): string {
  const base = id.split(':')[0].trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : id;
}

function storedSlmModels(): string[] {
  if (typeof window === 'undefined') return [];
  const raw = sessionStorage.getItem(SLM_MODEL_SESSION_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  } catch {
    return raw.trim() ? [raw.trim()] : [];
  }
  return [];
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
    /** lineIdx → corrected text + active change for pending review findings. */
    findings?: Map<number, { corrected: string; activeSegIdx: number | null }>;
    /** Apply a single inline review change (insertion/removal box click). */
    onApplySegment?: (lineIdx: number, segIdx: number) => void;
    /** Speech-normalized text; spans that get rewritten for reading are marked,
     *  with a hover tooltip showing what is actually spoken (like the read card). */
    readText?: string;
  };
  /** Rendered above the editor (right column), e.g. a review toolbar. */
  editHeader?: React.ReactNode;
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

function splitAtConjunction(line: string, at: number): [string, string] | null {
  const left = line.slice(0, at).replace(/\s+$/, '');
  const right = line.slice(at).replace(/^\s+/, '');
  return left === '' || right === '' ? null : [left, right];
}

function conjunctionSplit(line: string): [string, string] | null {
  const target = Math.floor(line.length / 2);
  let best = -1;
  let bestDistance = Infinity;
  for (const phrase of [' e ', ' and ']) {
    let at = line.indexOf(phrase);
    while (at !== -1) {
      const splitAt = at + 1;
      const distance = Math.abs(splitAt - target);
      if (distance < bestDistance) {
        best = splitAt;
        bestDistance = distance;
      }
      at = line.indexOf(phrase, at + phrase.length);
    }
  }
  return best === -1 ? null : splitAtConjunction(line, best);
}

// Break the first line longer than `maxLen`, preferring ; then : then ,
// between minLen and maxLen, then falling back before minLen. Returns null if
// nothing was broken.
function breakLineAt(
  lines: string[],
  lineIdx: number,
  minLen: number,
  maxLen: number,
  strategy: SplitStrategy,
): string[] | null {
  const line = lines[lineIdx];
  const proposal = proposeLineSplit(line, minLen, maxLen, strategy);
  if (!proposal) return null;
  const next = lines.slice();
  next.splice(lineIdx, 1, proposal.left, proposal.right);
  return next;
}

function proposeLineSplit(
  line: string,
  minLen: number,
  maxLen: number,
  strategy: SplitStrategy,
): SplitProposal | null {
  if (!line || line.length <= maxLen) return null;
  if (strategy === 'slm') return null;
  if (strategy === 'conjunction') {
    const split = conjunctionSplit(line);
    if (!split) return null;
    const [left, right] = split;
    return { original: line, left, right };
  }
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
  return { original: line, left, right };
}

function breakLongLine(
  text: string,
  minLen: number,
  maxLen: number,
  strategy: SplitStrategy,
  preferredLine?: number,
): string | null {
  const lines = text.split('\n');
  if (preferredLine !== undefined) {
    const preferred = breakLineAt(lines, preferredLine, minLen, maxLen, strategy);
    if (preferred) return preferred.join('\n');
  }
  for (let i = 0; i < lines.length; i++) {
    const next = breakLineAt(lines, i, minLen, maxLen, strategy);
    if (next) return next.join('\n');
  }
  return null;
}

// A line that doesn't end a sentence — but is followed by more text in the same
// paragraph — was broken out of necessity (a long-line split), not at a natural
// sentence end. Used to render a faint visual continuation marker.
function isContinuedLine(line: string, nextLine: string | undefined): boolean {
  const t = line.replace(/\s+$/, '');
  if (!t) return false;
  if (nextLine === undefined || nextLine.trim() === '') return false;
  return !/[.!?…]["'”’)\]]*$/.test(t);
}

// An auto-saving editor whose lines longer than `warnOver` get a light warning
// background. A plain <textarea> can't style individual lines, so a synced
// highlight backdrop sits behind a transparent-background textarea.
function HighlightEditor(
  { draft, onChange, onBlur, onUndo, warnOver, activeLine, findings, onApplySegment, readText }: NonNullable<PageViewProps['edit']>,
) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lines = draft.split('\n');
  const readLines = readText !== undefined ? readText.split('\n') : null;
  const readAligned = !!readLines && readLines.length === lines.length;
  const shared = 'p-0 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words';
  // With findings or speech marks the backdrop becomes the visible, hoverable layer
  // (above a transparent textarea) so changes render inline and the read-diff marks
  // can show their hover tooltip.
  const overlay = (!!findings && findings.size > 0) || readAligned;
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  const showTip = (e: React.MouseEvent, spoken: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ text: spoken, x: r.left + r.width / 2, y: r.top });
  };

  useEffect(() => {
    if (activeLine === null) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 18;
    textarea.scrollTop = Math.max(0, activeLine * lineHeight - textarea.clientHeight / 2);
    if (backdropRef.current) backdropRef.current.scrollTop = textarea.scrollTop;
  }, [activeLine, draft]);

  return (
    <div className="relative flex-1 min-h-[60vh]">
      <div
        ref={backdropRef}
        aria-hidden
        className={`absolute inset-0 overflow-hidden pointer-events-none ${overlay ? 'z-10 text-gray-200' : 'text-transparent'} ${shared}`}
      >
        {lines.map((line, i) => {
          const finding = findings?.get(i);
          const isActive = i === activeLine;
          const diff = overlay && finding && line.length ? diffText(line, finding.corrected) : null;
          if (diff) {
            return (
              <div key={i}>
                {diff.map((seg, k) => {
                  if (seg.read === null) return <span key={k}>{seg.text}</span>;
                  const on = finding!.activeSegIdx === k;
                  const apply = () => onApplySegment?.(i, k);
                  if (!seg.text && seg.read) {
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={apply}
                        title="Click to insert"
                        className={`pointer-events-auto mx-0.5 rounded px-1 align-middle ${on ? 'bg-emerald-500/60 text-emerald-50' : 'bg-emerald-500/20 text-emerald-200'} hover:bg-emerald-500/70`}
                      >
                        {seg.read}
                      </button>
                    );
                  }
                  if (seg.text && !seg.read) {
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={apply}
                        title="Click to remove"
                        className={`pointer-events-auto mx-0.5 inline-block h-3 w-5 rounded align-middle ${on ? 'bg-sky-500/70' : 'bg-sky-500/30'} hover:bg-sky-500/70`}
                      />
                    );
                  }
                  const blueCls = `rounded-sm px-0.5 ${on ? 'bg-sky-500/55 text-sky-50' : 'bg-sky-500/15 text-sky-300/80'}`;
                  const greenCls = `rounded-sm px-0.5 ${on ? 'bg-emerald-500/55 text-emerald-50' : 'bg-emerald-500/10 text-emerald-300/60'}`;
                  return (
                    <span key={k}>
                      <span className={blueCls}>{seg.text}</span>
                      <span className="text-gray-500"> → </span>
                      <span className={greenCls}>{seg.read}</span>
                    </span>
                  );
                })}
              </div>
            );
          }
          const readLine = readAligned && !finding ? readLines![i] : undefined;
          const readSegs = readLine !== undefined && readLine !== line ? diffText(line, readLine) : null;
          if (readSegs) {
            return (
              <div key={i}>
                {readSegs.map((s, k) => {
                  if (s.read === null) return <span key={k}>{s.text}</span>;
                  const spoken = s.read.trim() || 'omitted when read';
                  const cls = s.text === ''
                    ? 'bg-emerald-600/30 text-emerald-200 rounded-sm px-0.5 cursor-help pointer-events-auto'
                    : 'bg-amber-500/25 text-amber-200 rounded-sm cursor-help pointer-events-auto';
                  return (
                    <mark
                      key={k}
                      className={cls}
                      onMouseEnter={e => showTip(e, spoken)}
                      onMouseLeave={() => setTip(null)}
                    >
                      {s.text === '' ? '＋' : s.text}
                    </mark>
                  );
                })}
              </div>
            );
          }
          return (
          <div
            key={i}
            className={
              isActive
                ? 'bg-amber-500/35 outline outline-1 outline-amber-400/50 rounded-sm'
                : finding !== undefined
                  ? 'bg-sky-500/10 rounded-sm'
                  : line.length > warnOver ? 'bg-amber-500/15 rounded-sm' : ''
            }
          >
            {line.length ? line : ' '}
            {isContinuedLine(line, lines[i + 1]) && (
              <span className="text-sky-400/50 select-none" title="Line broken to fit (not a sentence end)"> _</span>
            )}
            {line.length > warnOver && (
              <span
                className={`relative -top-2 ml-1 text-[9px] leading-none ${
                  isActive ? 'text-gray-500' : 'text-gray-600'
                }`}
              >
                {line.length}
              </span>
            )}
          </div>
          );
        })}
      </div>
      <textarea
        ref={textareaRef}
        autoFocus
        spellCheck={false}
        className={`absolute inset-0 w-full h-full overflow-auto bg-transparent resize-none outline-none ${overlay ? 'text-transparent caret-gray-200' : 'text-gray-200'} ${shared}`}
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
    </div>
  );
}

function PageView({ bookId, page, large, preview, edit, editHeader }: PageViewProps) {
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
            {editHeader}
            <p className="text-[11px] text-gray-500 mb-2 shrink-0">
              One sentence per line · blank line separates paragraphs
            </p>
            <HighlightEditor {...edit} />
          </div>
        ) : page.status === 'processing' ? (
          <span className="text-xs text-amber-400 animate-pulse">Reading page…</span>
        ) : page.status === 'error' ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-red-400">OCR failed for this page</p>
            <p className="text-xs text-red-300 break-words whitespace-pre-wrap">
              {page.error || 'No details reported by the OCR server.'}
            </p>
          </div>
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
  const processed = ocrPages.filter(p => p.status === 'complete' || p.status === 'processing' || p.status === 'error');
  const done      = ocrPages.filter(p => p.status === 'complete').length;
  const failed    = ocrPages.filter(p => p.status === 'error').length;
  const total     = ocrPages.length;
  const current   = ocrPages.find(p => p.status === 'processing');

  const [idx,        setIdx]        = useState(0);
  const [userMoved,  setUserMoved]  = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [lineReviewFullscreen, setLineReviewFullscreen] = useState(false);
  const [draft,      setDraft]      = useState('');
  const [minLen,     setMinLen]     = useState(120);
  const [maxLen,     setMaxLen]     = useState(180);
  const [showSaved,  setShowSaved]  = useState(false);
  const [activeReview, setActiveReview] = useState<LineOccurrence | null>(null);
  const [splitStrategyIdx, setSplitStrategyIdx] = useState(0);
  const [slmProposal, setSlmProposal] = useState<SplitProposal | null>(null);
  const [slmLoading, setSlmLoading] = useState(false);
  const [slmError, setSlmError] = useState<string | null>(null);
  const [slmModels, setSlmModels] = useState<{ id: string; label: string }[]>([]);
  const [slmModelsLoading, setSlmModelsLoading] = useState(false);
  const [slmModelsError, setSlmModelsError] = useState<string | null>(null);
  const [showSlmModelPicker, setShowSlmModelPicker] = useState(false);
  const [selectedSlmModels, setSelectedSlmModels] = useState<string[]>(storedSlmModels);
  const [slmModelIdx, setSlmModelIdx] = useState(0);
  const [typos, setTypos] = useState<TypoFinding[]>([]);
  const [activeTypoSel, setActiveTypoSel] = useState<{ page: number; lineIdx: number; segIdx: number } | null>(null);
  const [reviewModel, setReviewModel] = useState<string>(storedReviewModel);
  const [showReviewModelPicker, setShowReviewModelPicker] = useState(false);
  const [typoScanLoading, setTypoScanLoading] = useState(false);
  const [typoScanError, setTypoScanError] = useState<string | null>(null);
  const [typoScanProgress, setTypoScanProgress] = useState<{ done: number; total: number } | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  const undoStack = useRef<string[]>([]);
  const pendingReviewScan = useRef(false);
  // Pages whose AI review has already run (foreground or prefetch), keyed
  // `${page}:${model}`, plus the ones currently being prefetched — so the
  // background prefetch never repeats or races a page.
  const reviewedPages = useRef<Set<string>>(new Set());
  const prefetchInFlight = useRef<Set<string>>(new Set());

  const flashSaved = useCallback(() => {
    setShowSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setShowSaved(false), 1500);
  }, []);

  useEffect(() => () => clearTimeout(savedTimer.current), []);

  // Wipe all AI review findings/state — run when the reading-pages modal closes.
  const clearReviewState = useCallback(() => {
    setTypos([]);
    setActiveTypoSel(null);
    setTypoScanError(null);
    setTypoScanProgress(null);
    setTypoScanLoading(false);
    reviewedPages.current.clear();
    prefetchInFlight.current.clear();
  }, []);

  useEffect(() => {
    if (!userMoved && processed.length > 0) setIdx(processed.length - 1);
  }, [processed.length, userMoved]);

  useEffect(() => {
    setSlmModelIdx(i => Math.min(i, Math.max(0, selectedSlmModels.length - 1)));
  }, [selectedSlmModels.length]);

  useEffect(() => {
    if (!fullscreen && !lineReviewFullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (lineReviewFullscreen) setLineReviewFullscreen(false);
      else { setFullscreen(false); clearReviewState(); }
    };
    window.addEventListener('keydown', handler);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen, lineReviewFullscreen, clearReviewState]);

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
  const splitStrategy = SPLIT_STRATEGIES[splitStrategyIdx] ?? 'punctuation';
  const activeSlmModel = selectedSlmModels[slmModelIdx] ?? selectedSlmModels[0] ?? '';

  const reviewOccurrences = useMemo<LineOccurrence[]>(() => {
    const items: LineOccurrence[] = [];
    processed.forEach((p, pageIdx) => {
      const text = pageIdx === safeIdx ? draft : (p.text ?? '');
      text.split('\n').forEach((line, lineIdx) => {
        if (line.length > maxLen) items.push({ pageIdx, page: p.page, lineIdx, kind: 'long' });
      });
    });
    return items;
  }, [processed, safeIdx, draft, maxLen]);

  const activeReviewIndex = activeReview
    ? reviewOccurrences.findIndex(o => o.page === activeReview.page && o.lineIdx === activeReview.lineIdx)
    : -1;
  const currentPageFirstReview = reviewOccurrences.find(o => o.pageIdx === safeIdx) ?? null;
  const currentPageIssueCount = draft.split('\n').filter(line => line.length > maxLen).length;

  // Grammar/typo findings reviewed in the reading-pages fullscreen (where the PDF
  // preview shows the original), kept separate from the long-line review above.
  // One item per individual word-level change so each is approved on its own.
  const typoList = useMemo(
    () => deriveTypoChanges(typos, processed, safeIdx, draft),
    [processed, safeIdx, draft, typos],
  );
  // Only the current page's findings are reviewed at a time; the reviewer
  // navigates pages to reach the rest.
  const pageTypoList = useMemo(() => typoList.filter(t => t.pageIdx === safeIdx), [typoList, safeIdx]);

  const activeTypoIndex = activeTypoSel
    ? pageTypoList.findIndex(t => t.page === activeTypoSel.page && t.lineIdx === activeTypoSel.lineIdx && t.segIdx === activeTypoSel.segIdx)
    : -1;
  const activeTypo = activeTypoIndex >= 0 ? pageTypoList[activeTypoIndex] : null;
  const currentPageFindings = useMemo(() => {
    const m = new Map<number, { corrected: string; activeSegIdx: number | null }>();
    pageTypoList.forEach(t => {
      if (!m.has(t.lineIdx)) m.set(t.lineIdx, { corrected: t.corrected, activeSegIdx: null });
    });
    if (activeTypo) {
      const entry = m.get(activeTypo.lineIdx);
      if (entry) entry.activeSegIdx = activeTypo.segIdx;
    }
    return m;
  }, [pageTypoList, activeTypo]);
  const activeSplitLineIdx = useMemo(() => {
    const reviewLine = activeReview && page && activeReview.page === page.page ? activeReview.lineIdx : undefined;
    const lines = draft.split('\n');
    return reviewLine ?? lines.findIndex(line => line.length > maxLen);
  }, [activeReview, page?.page, draft, maxLen]);
  const activeSplitLine = activeSplitLineIdx >= 0 ? draft.split('\n')[activeSplitLineIdx] : '';
  const activeLocalSplitPreview = useMemo<SplitProposal | null>(() => {
    const lines = draft.split('\n');
    return activeSplitLineIdx >= 0 && splitStrategy !== 'slm'
      ? proposeLineSplit(lines[activeSplitLineIdx], minLen, maxLen, splitStrategy)
      : null;
  }, [activeSplitLineIdx, draft, minLen, maxLen, splitStrategy]);
  const slmPreviewStale = splitStrategy === 'slm' && !!activeSplitLine && slmProposal?.original !== activeSplitLine;
  const activeSplitPreview = splitStrategy === 'slm'
    ? (slmPreviewStale ? null : slmProposal)
    : activeLocalSplitPreview;
  const needsSlmModel = splitStrategy === 'slm' && selectedSlmModels.length === 0;
  const showSlmLoading = splitStrategy === 'slm' && !!activeSplitLine && !needsSlmModel && (slmLoading || slmPreviewStale);
  const showSplitComparison = !!(activeSplitLine || activeSplitPreview || showSlmLoading || (splitStrategy === 'slm' && slmError && !slmPreviewStale));
  const canAcceptSplit = !!activeSplitPreview && !slmLoading;

  useEffect(() => {
    if (splitStrategy !== 'slm' || selectedSlmModels.length > 0) return;
    setShowSlmModelPicker(true);
  }, [splitStrategy, selectedSlmModels.length]);

  useEffect(() => {
    if ((!showSlmModelPicker && !showReviewModelPicker) || slmModels.length || slmModelsLoading) return;
    setSlmModelsLoading(true);
    setSlmModelsError(null);
    api.get<{ id: string; label: string }[]>('/api/books/line-split/models')
      .then(res => setSlmModels(res.data))
      .catch(err => setSlmModelsError(err?.response?.data?.error || err?.message || 'Failed to list SLM models'))
      .finally(() => setSlmModelsLoading(false));
  }, [showSlmModelPicker, showReviewModelPicker, slmModels.length, slmModelsLoading]);

  useEffect(() => {
    setSlmProposal(null);
    setSlmError(null);
    if (splitStrategy !== 'slm' || activeSplitLineIdx < 0 || !activeSlmModel) {
      setSlmLoading(false);
      return;
    }

    const line = activeSplitLine;
    if (!line || line.length <= maxLen) {
      setSlmLoading(false);
      return;
    }

    let cancelled = false;
    setSlmLoading(true);
    api.post<{ left: string; right: string }>(`/api/books/${bookId}/line-split`, { line, model: activeSlmModel })
      .then(res => {
        if (cancelled) return;
        const left = res.data.left?.trim();
        const right = res.data.right?.trim();
        setSlmProposal(left && right ? { original: line, left, right } : null);
        setSlmError(left && right ? null : 'No sentence split found');
      })
      .catch(err => {
        if (cancelled) return;
        const msg = err?.response?.data?.error || err?.message || 'Failed to split line';
        setSlmError(msg);
      })
      .finally(() => { if (!cancelled) setSlmLoading(false); });

    return () => { cancelled = true; };
  }, [splitStrategy, activeSplitLine, maxLen, bookId, activeSlmModel]);

  useEffect(() => {
    if (!activeReview) return;
    if (activeReviewIndex === -1) setActiveReview(null);
  }, [activeReview, activeReviewIndex]);

  // Keep the active finding pointed at the current page: if the selection no
  // longer matches a finding here (e.g. after a page change), fall back to the
  // first finding on this page, or clear it when there are none.
  useEffect(() => {
    if (activeTypoIndex !== -1) return;
    const first = pageTypoList[0];
    setActiveTypoSel(first ? { page: first.page, lineIdx: first.lineIdx, segIdx: first.segIdx } : null);
  }, [activeTypoIndex, pageTypoList]);

  // Keep the editor draft in sync with the page being shown.
  useEffect(() => {
    setDraft(page?.text ?? '');
    undoStack.current = [];
  }, [page?.page, fullscreen]);

  // Run the per-line AI grammar/typo check for one page's text. Shared by the
  // foreground "Review" button and the background prefetch.
  const reviewLines = async (
    text: string,
    targetPage: number,
    model: string,
    pool: number,
    onProgress?: () => void,
  ): Promise<{ found: TypoFinding[]; failures: number; lastError: string; total: number }> => {
    const targets = text.split('\n')
      .map((line, lineIdx) => ({ line, lineIdx }))
      .filter(t => t.line.trim().length > 0);
    const found: TypoFinding[] = [];
    let failures = 0;
    let lastError = '';
    await runPool(targets, pool, async ({ line, lineIdx }) => {
      try {
        const res = await api.post<{ corrected: string }>(`/api/books/${bookId}/line-typos`, { line, model });
        const corrected = (res.data?.corrected ?? '').trim();
        if (corrected && corrected !== line.trim()) {
          found.push({ page: targetPage, lineIdx, original: line, corrected });
        }
      } catch (err: any) {
        failures++;
        lastError = err?.response?.data?.error || err?.message || 'Typo check failed';
      } finally {
        onProgress?.();
      }
    });
    return { found, failures, lastError, total: targets.length };
  };

  // The up-to-3 complete pages ahead of the current one, serialized so the
  // prefetch effect only re-fires when that set actually changes (not on every
  // keystroke-driven re-render).
  const prefetchPlan = useMemo(() => {
    if (!fullscreen || !reviewModel) return '[]';
    const t = processed[safeIdx + 1];
    if (t && t.status === 'complete' && (t.text ?? '').trim()) {
      return JSON.stringify([{ page: t.page, text: t.text ?? '' }]);
    }
    return '[]';
  }, [fullscreen, reviewModel, processed, safeIdx]);

  // Review the next pages in the background so findings are ready on arrival.
  useEffect(() => {
    if (!reviewModel) return;
    const plan: { page: number; text: string }[] = JSON.parse(prefetchPlan);
    if (plan.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const target of plan) {
        if (cancelled) return;
        const key = `${target.page}:${reviewModel}`;
        if (reviewedPages.current.has(key) || prefetchInFlight.current.has(key)) continue;
        prefetchInFlight.current.add(key);
        try {
          const { found } = await reviewLines(target.text, target.page, reviewModel, 3);
          reviewedPages.current.add(key);
          setTypos(prev => [...prev.filter(t => t.page !== target.page), ...found]);
        } catch {
          // Prefetch is best-effort; a failed page just gets reviewed on arrival.
        } finally {
          prefetchInFlight.current.delete(key);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [prefetchPlan, reviewModel]);

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

  const saveText = (text: string) => {
    dispatch(updatePageText({ bookId, page: page.page, text }));
    flashSaved();
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

  const selectTypo = (t: TypoChange) =>
    setActiveTypoSel({ page: t.page, lineIdx: t.lineIdx, segIdx: t.segIdx });

  // After a change is applied/discarded, keep the selection where it was, or
  // advance to the change now at that position, staying on the current page.
  const reselectAfter = (nextTypos: TypoFinding[], text: string) => {
    const remaining = deriveTypoChanges(nextTypos, processed, safeIdx, text).filter(c => c.pageIdx === safeIdx);
    const stillActive = activeTypoSel &&
      remaining.find(c => c.page === activeTypoSel.page && c.lineIdx === activeTypoSel.lineIdx && c.segIdx === activeTypoSel.segIdx);
    const upcoming = stillActive ?? remaining[activeTypoIndex] ?? remaining[remaining.length - 1] ?? null;
    setActiveTypoSel(upcoming ? { page: upcoming.page, lineIdx: upcoming.lineIdx, segIdx: upcoming.segIdx } : null);
  };

  const nextTypo = () => {
    if (pageTypoList.length === 0) return;
    selectTypo(pageTypoList[activeTypoIndex + 1] ?? pageTypoList[0]);
  };

  const prevTypo = () => {
    if (pageTypoList.length === 0) return;
    selectTypo(activeTypoIndex > 0 ? pageTypoList[activeTypoIndex - 1] : pageTypoList[pageTypoList.length - 1]);
  };

  // Accept a single change (apply the SLM correction for that segment).
  const acceptChange = (change: TypoChange) => {
    if (change.pageIdx !== safeIdx) return;
    const lines = draft.split('\n');
    if (lines[change.lineIdx] !== change.original) return;
    const newLine = applyTypoChange(change.original, change.corrected, change.segIdx);
    lines[change.lineIdx] = newLine;
    const result = lines.join('\n');
    changeDraft(result);
    saveText(result);

    const nextTypos = typos.flatMap(t => {
      if (t.page !== change.page || t.lineIdx !== change.lineIdx) return [t];
      return newLine === t.corrected ? [] : [{ ...t, original: newLine }];
    });
    setTypos(nextTypos);
    reselectAfter(nextTypos, result);
  };

  // Discard a single change (keep the original OCR text for that segment).
  const discardChange = (change: TypoChange) => {
    const newCorrected = discardTypoChange(change.original, change.corrected, change.segIdx);
    const nextTypos = typos.flatMap(t => {
      if (t.page !== change.page || t.lineIdx !== change.lineIdx) return [t];
      return newCorrected === t.original ? [] : [{ ...t, corrected: newCorrected }];
    });
    setTypos(nextTypos);
    reselectAfter(nextTypos, draft);
  };

  const acceptTypo = () => { if (activeTypo) acceptChange(activeTypo); };
  const discardTypo = () => { if (activeTypo) discardChange(activeTypo); };
  const applySegment = (lineIdx: number, segIdx: number) => {
    const change = pageTypoList.find(t => t.lineIdx === lineIdx && t.segIdx === segIdx);
    if (change) acceptChange(change);
  };

  const scanTypos = async (
    modelOverride?: string,
    target?: { pageIdx: number; page: number; text: string },
  ) => {
    const model = modelOverride || reviewModel;
    if (!model) { pendingReviewScan.current = true; setShowReviewModelPicker(true); return; }
    setUserMoved(true);
    const tgt = target ?? { pageIdx: safeIdx, page: page.page, text: draft };
    const targetPage = tgt.page;
    const lineCount = tgt.text.split('\n').filter(line => line.trim().length > 0).length;

    setTypoScanError(null);
    setTypoScanLoading(true);
    setTypoScanProgress({ done: 0, total: lineCount });
    // A single line's failure must not abort the whole page (so the page still
    // gets marked reviewed); per-line errors are collected, not thrown.
    const { found, failures, lastError, total } = await reviewLines(
      tgt.text, targetPage, model, 6,
      () => setTypoScanProgress(p => (p ? { done: p.done + 1, total: p.total } : p)),
    );

    setTypoScanLoading(false);
    setTypoScanProgress(null);

    if (total > 0 && failures === total) {
      setTypoScanError(lastError || 'Typo check failed');
      return;
    }

    setTypoScanError(failures > 0 ? `${failures} line(s) could not be reviewed` : null);
    reviewedPages.current.add(`${targetPage}:${model}`);
    const nextTypos = [...typos.filter(t => t.page !== targetPage), ...found];
    setTypos(nextTypos);
    const changes = deriveTypoChanges(nextTypos, processed, tgt.pageIdx, tgt.text);
    const firstOnPage = changes.find(c => c.page === targetPage);
    if (firstOnPage) {
      setActiveTypoSel({ page: firstOnPage.page, lineIdx: firstOnPage.lineIdx, segIdx: firstOnPage.segIdx });
    } else {
      setActiveTypoSel(sel => (sel?.page === targetPage ? null : sel));
    }
  };


  const breakLine = () => {
    if (activeSplitPreview && activeSplitLineIdx >= 0) {
      const lines = draft.split('\n');
      lines.splice(activeSplitLineIdx, 1, activeSplitPreview.left, activeSplitPreview.right);
      const result = lines.join('\n');
      changeDraft(result);
      saveText(result);
      setActiveReview(null);
      return;
    }
    const reviewLine = activeReview?.page === page.page ? activeReview.lineIdx : undefined;
    const result = breakLongLine(draft, minLen, maxLen, splitStrategy, reviewLine);
    if (result === null) return;
    changeDraft(result);
    saveText(result);
    setActiveReview(null);
  };

  const cycleSplitStrategy = () => {
    const line = draft.split('\n')[activeSplitLineIdx];
    if (!line) return;
    if (splitStrategy === 'slm' && selectedSlmModels.length > 0 && slmModelIdx < selectedSlmModels.length - 1) {
      setSlmModelIdx(i => i + 1);
      return;
    }
    setSplitStrategyIdx(currentIdx => {
      for (let offset = 1; offset <= SPLIT_STRATEGIES.length; offset++) {
        const nextIdx = (currentIdx + offset) % SPLIT_STRATEGIES.length;
        if (SPLIT_STRATEGIES[nextIdx] === 'slm') {
          setSlmModelIdx(0);
          return nextIdx;
        }
        if (proposeLineSplit(line, minLen, maxLen, SPLIT_STRATEGIES[nextIdx])) return nextIdx;
      }
      return currentIdx;
    });
  };

  const selectSlmModel = (model: string) => {
    sessionStorage.setItem(SLM_MODEL_SESSION_KEY, JSON.stringify([model]));
    setSelectedSlmModels([model]);
    setSlmModelIdx(0);
    setShowSlmModelPicker(false);
  };

  const selectReviewModel = (model: string) => {
    sessionStorage.setItem(REVIEW_MODEL_SESSION_KEY, model);
    setReviewModel(model);
    setShowReviewModelPicker(false);
    if (pendingReviewScan.current) {
      pendingReviewScan.current = false;
      scanTypos(model);
    }
  };

  const closeSlmModelPicker = () => {
    setShowSlmModelPicker(false);
    if (selectedSlmModels.length === 0) setSplitStrategyIdx(0);
  };

  const openLineReview = () => {
    setLineReviewFullscreen(true);
    if (activeReview) return;
    if (currentPageFirstReview) {
      setActiveReview(currentPageFirstReview);
      return;
    }
    if (draft !== (page.text ?? '')) return;
    if (reviewOccurrences.length > 0) nextReview();
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
              onClick={openLineReview}
              title="Review long lines"
              aria-label="Review long lines"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 6h11M4 11h11M4 16h7M14 17l2.5 2.5L21 15" />
              </svg>
            </button>
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
          {failed > 0 && <span className="text-red-400"> · {failed} failed</span>}
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
                {failed > 0 && <span className="text-red-400 ml-1">· {failed} failed</span>}
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

            <div className="flex items-center shrink-0">
              <button
                className="h-7 w-7 rounded-l flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
                onClick={() => setShowReviewModelPicker(true)}
                title="Choose review model"
                aria-label="Choose review model"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 3l1.6 4.6L18 9l-4.4 1.4L12 15l-1.6-4.6L6 9l4.4-1.4L12 3zM5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" />
                </svg>
              </button>
              <button
                className="h-7 rounded-r px-2 flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-40 transition-colors"
                onClick={() => scanTypos()}
                disabled={typoScanLoading}
                title={typoScanError ? `Review failed: ${typoScanError}` : 'Review this page for grammar and typos'}
                aria-label="Review this page for grammar and typos"
              >
                {typoScanLoading && (
                  <svg className="w-4 h-4 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
                  </svg>
                )}
                <span className="whitespace-nowrap">
                  {typoScanLoading && typoScanProgress
                    ? `Reviewing ${typoScanProgress.done}/${typoScanProgress.total}`
                    : reviewModel ? `Review by ${prettyModel(reviewModel)}` : 'Review with AI'}
                </span>
              </button>
              <button
                className="h-7 w-7 ml-1 rounded flex items-center justify-center text-gray-400 enabled:hover:text-red-300 enabled:hover:bg-gray-800 disabled:opacity-30 transition-colors"
                onClick={clearReviewState}
                disabled={typos.length === 0}
                title="Clear all reviews"
                aria-label="Clear all reviews"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}>
                  <path d="M19 20H8.5l-4.21-4.3a1 1 0 0 1 0-1.41l10-10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41L11.5 20" />
                  <path d="M18 13.3l-6.3-6.3" />
                </svg>
              </button>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
                onClick={() => { saveDraft(); prev(); }}
                disabled={safeIdx === 0}
                title="Previous page"
                aria-label="Previous page"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="font-mono text-sm text-gray-200 tabular-nums text-center min-w-[2.5ch]">{page.page}</span>
              <button
                className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
                onClick={() => { saveDraft(); next(); }}
                disabled={safeIdx === processed.length - 1}
                title="Next page"
                aria-label="Next page"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>

            <button
              className="w-8 h-8 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors shrink-0"
              onClick={() => { saveDraft(); setFullscreen(false); clearReviewState(); }}
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
              editHeader={(pageTypoList.length > 0 || typoScanError) ? (
                <div className="mb-2 shrink-0 rounded-lg border border-gray-800 bg-gray-900/70 p-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500 tabular-nums shrink-0">
                      {pageTypoList.length === 0
                        ? 'No findings'
                        : `${activeTypoIndex >= 0 ? activeTypoIndex + 1 : '-'} / ${pageTypoList.length}`}
                    </span>
                    <div className="min-w-0 flex-1 rounded border border-gray-700/60 bg-gray-900/40 px-2 py-1.5">
                      {activeTypo ? (() => {
                        const ctx = segContext(activeTypo.original, activeTypo.corrected, activeTypo.segIdx);
                        return (
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs">
                            {ctx.before && <span className="text-gray-500">…{ctx.before}</span>}
                            {activeTypo.oldSeg.trim() && (
                              <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-sky-100">{activeTypo.oldSeg.trim()}</span>
                            )}
                            <span className="text-gray-500">→</span>
                            {activeTypo.newSeg.trim()
                              ? <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-100">{activeTypo.newSeg.trim()}</span>
                              : <span className="text-[11px] uppercase tracking-wide text-gray-500">removed</span>}
                            {ctx.after && <span className="text-gray-500">{ctx.after}…</span>}
                          </div>
                        );
                      })() : typoScanError ? (
                        <p className="text-xs text-red-300">{typoScanError}</p>
                      ) : (
                        <p className="text-xs text-gray-500">Select a finding to review.</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
                        onClick={prevTypo}
                        disabled={pageTypoList.length === 0}
                        title="Previous finding"
                        aria-label="Previous finding"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                      <button
                        className="h-7 max-w-[12rem] truncate rounded px-2.5 font-mono text-xs bg-sky-500/15 text-sky-100 hover:bg-sky-500/30 disabled:opacity-30 transition-colors"
                        onClick={discardTypo}
                        disabled={!activeTypo}
                        title="Keep the original OCR text"
                        aria-label="Keep the original OCR text"
                      >
                        {activeTypo?.oldSeg.trim() || '∅'}
                      </button>
                      <button
                        className="h-7 max-w-[12rem] truncate rounded px-2.5 font-mono text-xs bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-30 transition-colors"
                        onClick={acceptTypo}
                        disabled={!activeTypo}
                        title="Accept the SLM correction"
                        aria-label="Accept the SLM correction"
                      >
                        {activeTypo?.newSeg.trim() || '∅'}
                      </button>
                      <button
                        className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
                        onClick={nextTypo}
                        disabled={pageTypoList.length === 0}
                        title="Next finding"
                        aria-label="Next finding"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
              edit={{
                draft,
                onChange: changeDraft,
                onBlur: saveDraft,
                onUndo: undoDraft,
                warnOver: Number.POSITIVE_INFINITY,
                activeLine: activeTypo?.page === page.page ? activeTypo.lineIdx : null,
                findings: currentPageFindings,
                onApplySegment: applySegment,
                readText: page.readText,
              }}
            />
          </div>
        </div>,
        document.body,
      )}

      {lineReviewFullscreen && createPortal(
        <div className="fixed inset-0 z-50 h-[100dvh] w-screen bg-gray-950 flex flex-col">
          <div className="relative flex items-center gap-4 px-6 py-4 border-b border-gray-800 shrink-0">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <h2 className="font-semibold text-gray-100">Line review</h2>
              <p className="text-xs text-gray-500">
                P. {page.page}
                <span className="ml-1">· {currentPageIssueCount} on this page</span>
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

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Target</span>
              <input
                type="number"
                value={minLen}
                onChange={e => setMinLen(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-14 h-7 px-1 text-center text-xs bg-gray-800 border border-gray-700 rounded text-gray-200 outline-none focus:border-gray-500"
                title="Min line length"
              />
              <span className="text-gray-600 text-xs">-</span>
              <input
                type="number"
                value={maxLen}
                onChange={e => setMaxLen(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-14 h-7 px-1 text-center text-xs bg-gray-800 border border-gray-700 rounded text-gray-200 outline-none focus:border-gray-500"
                title="Max line length"
              />
            </div>

            <button
              className="w-8 h-8 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors shrink-0"
              onClick={() => { saveDraft(); setLineReviewFullscreen(false); }}
              title="Close (Esc)"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="border-b border-gray-800 bg-gray-900/80 px-6 py-3 shrink-0">
              <div className="mb-2 flex h-7 items-center justify-between gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500 tabular-nums">
                  {reviewOccurrences.length === 0
                    ? '0 issues'
                    : `${activeReviewIndex >= 0 ? activeReviewIndex + 1 : '-'} / ${reviewOccurrences.length}`}
                </span>
                <div className="flex items-center gap-1">
                  {splitStrategy === 'slm' && (
                    <button
                      className="h-7 max-w-48 rounded px-2 flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
                      onClick={() => setShowSlmModelPicker(true)}
                      title="Choose SLM model"
                      aria-label="Choose SLM model"
                    >
                      <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M12 3l1.6 4.6L18 9l-4.4 1.4L12 15l-1.6-4.6L6 9l4.4-1.4L12 3zM5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" />
                      </svg>
                      <span className="truncate">{activeSlmModel || 'Choose model'}</span>
                    </button>
                  )}
                  <button
                    className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
                    onClick={prevReview}
                    disabled={reviewOccurrences.length === 0}
                    title="Previous long line"
                    aria-label="Previous long line"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <button
                    className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
                    onClick={breakLine}
                    disabled={!canAcceptSplit}
                    title="Accept current long-line split"
                    aria-label="Accept current long-line split"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </button>
                  <button
                    className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
                    onClick={nextReview}
                    disabled={reviewOccurrences.length === 0}
                    title="Next long line"
                    aria-label="Next long line"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                  <button
                    className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
                    onClick={cycleSplitStrategy}
                    title={`Try another split strategy (${splitStrategy === 'punctuation' ? 'punctuation' : splitStrategy === 'conjunction' ? 'and/e' : activeSlmModel || 'SLM'})`}
                    aria-label="Try another split strategy"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M20 11a8.1 8.1 0 00-15.5-2M4 5v4h4M4 13a8.1 8.1 0 0015.5 2M20 19v-4h-4" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="min-w-0">
                  <div className="mb-1 flex h-7 items-center">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Current</p>
                  </div>
                  <p className="min-h-9 rounded border border-red-900/50 bg-red-950/20 px-3 py-2 font-mono text-xs leading-relaxed text-red-100 break-words">
                    {showSplitComparison ? activeSplitPreview?.original ?? activeSplitLine : null}
                  </p>
                </div>
                <div className="min-w-0">
                  <div className="mb-1 flex h-7 items-center">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">After Accept</p>
                  </div>
                  <div className="min-h-9 space-y-4 rounded border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 font-mono text-xs leading-relaxed text-emerald-100 break-words">
                    {!showSplitComparison ? null : showSlmLoading ? (
                      <p className="text-emerald-100/60">Thinking…</p>
                    ) : activeSplitPreview ? (
                      <>
                        <p>{activeSplitPreview.left}</p>
                        <p>{activeSplitPreview.right}</p>
                      </>
                    ) : (
                      <p className="text-emerald-100/60">{slmError ?? 'No split available for this strategy.'}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>

          <div className="flex-1 min-h-0 p-4">
            <div className="h-full min-h-0 rounded-lg bg-gray-800/50 p-3">
              <div className="flex h-full min-h-0 flex-col">
                <p className="text-[11px] text-gray-500 mb-2 shrink-0">
                  One sentence per line · blank line separates paragraphs
                </p>
                <HighlightEditor
                  draft={draft}
                  onChange={changeDraft}
                  onBlur={saveDraft}
                  onUndo={undoDraft}
                  warnOver={maxLen}
                  activeLine={activeReview?.page === page.page ? activeReview.lineIdx : null}
                />
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {showSlmModelPicker && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-lg border border-gray-800 bg-gray-950 shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
              <h3 className="font-semibold text-gray-100">Select split model</h3>
              <button
                className="w-8 h-8 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
                onClick={closeSlmModelPicker}
                title="Close"
                aria-label="Close"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-2 p-4">
              {slmModelsLoading ? (
                <p className="text-sm text-gray-400">Loading models…</p>
              ) : slmModelsError ? (
                <p className="text-sm text-red-300">{slmModelsError}</p>
              ) : slmModels.length === 0 ? (
                <p className="text-sm text-gray-400">No SLM models available.</p>
              ) : (
                slmModels.map(model => (
                  <button
                    key={model.id}
                    className={`flex w-full items-center justify-between gap-3 rounded border px-3 py-2 text-left text-sm transition-colors ${
                      selectedSlmModels.includes(model.id)
                        ? 'border-gray-600 bg-gray-800 text-gray-100'
                        : 'border-gray-800 bg-gray-900 text-gray-200 hover:border-gray-700 hover:bg-gray-800'
                    }`}
                    onClick={() => selectSlmModel(model.id)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{model.label || model.id}</span>
                      <span className="block truncate font-mono text-[11px] text-gray-500">{model.id}</span>
                    </span>
                    {selectedSlmModels.includes(model.id) && (
                      <svg className="w-4 h-4 shrink-0 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                ))
              )}
              {slmModelsError && (
                <button
                  className="btn-secondary w-full justify-center"
                  onClick={() => {
                    setSlmModelsLoading(true);
                    setSlmModelsError(null);
                    api.get<{ id: string; label: string }[]>('/api/books/line-split/models')
                      .then(res => setSlmModels(res.data))
                      .catch(err => setSlmModelsError(err?.response?.data?.error || err?.message || 'Failed to list SLM models'))
                      .finally(() => setSlmModelsLoading(false));
                  }}
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {showReviewModelPicker && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-lg border border-gray-800 bg-gray-950 shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
              <h3 className="font-semibold text-gray-100">Select review model</h3>
              <button
                className="w-8 h-8 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
                onClick={() => { pendingReviewScan.current = false; setShowReviewModelPicker(false); }}
                title="Close"
                aria-label="Close"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-2 p-4">
              {slmModelsLoading ? (
                <p className="text-sm text-gray-400">Loading models…</p>
              ) : slmModelsError ? (
                <p className="text-sm text-red-300">{slmModelsError}</p>
              ) : slmModels.length === 0 ? (
                <p className="text-sm text-gray-400">No models available.</p>
              ) : (
                slmModels.map(model => (
                  <button
                    key={model.id}
                    className={`flex w-full items-center justify-between gap-3 rounded border px-3 py-2 text-left text-sm transition-colors ${
                      reviewModel === model.id
                        ? 'border-gray-600 bg-gray-800 text-gray-100'
                        : 'border-gray-800 bg-gray-900 text-gray-200 hover:border-gray-700 hover:bg-gray-800'
                    }`}
                    onClick={() => selectReviewModel(model.id)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{model.label || model.id}</span>
                      <span className="block truncate font-mono text-[11px] text-gray-500">{model.id}</span>
                    </span>
                    {reviewModel === model.id && (
                      <svg className="w-4 h-4 shrink-0 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                ))
              )}
              {slmModelsError && (
                <button
                  className="btn-secondary w-full justify-center"
                  onClick={() => {
                    setSlmModelsLoading(true);
                    setSlmModelsError(null);
                    api.get<{ id: string; label: string }[]>('/api/books/line-split/models')
                      .then(res => setSlmModels(res.data))
                      .catch(err => setSlmModelsError(err?.response?.data?.error || err?.message || 'Failed to list SLM models'))
                      .finally(() => setSlmModelsLoading(false));
                  }}
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
});

export default TextReview;
