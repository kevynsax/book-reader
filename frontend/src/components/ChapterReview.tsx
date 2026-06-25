import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../store';
import { updateChapters } from '../store/booksSlice';
import { api } from '../api/booksApi';
import { Book } from '../types';
import PagePreview from './PagePreview';
import { t } from '../i18n';

interface ChapterSuggestion {
  title: string;
  page: number;
  startChar: number;
  found: boolean;
}

interface Props {
  book: Book;
  onConfirm: (chapters: { title: string; startPage: number; startChar: number }[]) => Promise<void>;
  /** Open the reading-pages fullscreen viewer at the given page. */
  onOpenPage?: (page: number) => void;
}

interface Row { title: string; startPage: number; label: string; }

export interface ChapterReviewHandle {
  submit: () => Promise<void>;
  save: () => Promise<void>;
}

function wordAtOffset(text: string, offset: number): string {
  const at = Math.max(0, Math.min(offset, text.length));
  const midWord = at > 0 && /\S/.test(text[at - 1] ?? '') && /\S/.test(text[at] ?? '');
  const rest = midWord ? text.slice(at).replace(/^\S+/, '') : text.slice(at);
  return rest.trimStart().match(/^\S+/)?.[0] ?? '';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fold(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Mirror of the backend matcher: words of a title are often broken across lines
// (common on chapter title pages), so match them in order while allowing any
// whitespace/punctuation run between them.
const TITLE_SEP = '[\\s.·•–—:_-]+';

function titleRegex(needle: string): RegExp | null {
  const parts = needle.split(/[\s.·•–—:_-]+/).filter(Boolean).map(escapeRegex);
  if (parts.length === 0) return null;
  return new RegExp(parts.join(TITLE_SEP), 'i');
}

function findFlexible(text: string, needle: string): { index: number; length: number } | null {
  const direct = titleRegex(needle)?.exec(text);
  if (direct) return { index: direct.index, length: direct[0].length };
  // Accent-insensitive fallback; NFKD keeps positions for single-accent Latin chars.
  const folded = titleRegex(fold(needle))?.exec(fold(text));
  if (folded) return { index: folded.index, length: folded[0].length };
  return null;
}

function highlight(excerpt: string, needle: string) {
  if (!needle) return <span>{excerpt}</span>;
  const m = findFlexible(excerpt, needle);
  if (!m) return <span>{excerpt}</span>;
  return (
    <>
      {excerpt.slice(0, m.index)}
      <span className="font-semibold text-green-300 bg-green-950/60 rounded px-0.5">{excerpt.slice(m.index, m.index + m.length)}</span>
      {excerpt.slice(m.index + m.length)}
    </>
  );
}

const ChapterReview = forwardRef<ChapterReviewHandle, Props>(function ChapterReview({ book, onConfirm, onOpenPage }, ref) {
  const dispatch = useDispatch<AppDispatch>();

  // The contents can span several pages; the preview opens on the first one.
  const summaryPage = book.summaryPages?.[0] ?? 1;

  const pageText = (page: number) => book.ocrPages.find(p => p.page === page)?.text?.trim() ?? '';

  const [rows, setRows] = useState<Row[]>(() =>
    book.chapters.map(c => ({
      title: c.title,
      startPage: c.startPage,
      label: wordAtOffset(pageText(c.startPage), c.startChar ?? 0),
    }))
  );
  const [error, setError] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);

  const [detecting,   setDetecting]   = useState(false);
  const [suggestions, setSuggestions] = useState<ChapterSuggestion[] | null>(null);
  const [previewPage, setPreviewPage] = useState(summaryPage);
  const [editingIdx,  setEditingIdx]  = useState<number | null>(null);
  const suggestionsRef = useRef<ChapterSuggestion[] | null>(null);
  const pageRepeatDelayRef = useRef<number | null>(null);
  const pageRepeatIntervalRef = useRef<number | null>(null);

  const previewTotal = book.totalPages || book.lastPage;

  useEffect(() => { suggestionsRef.current = suggestions; }, [suggestions]);

  useEffect(() => {
    if (!showSummary) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowSummary(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showSummary]);

  const stopPageRepeat = () => {
    if (pageRepeatDelayRef.current !== null) {
      window.clearTimeout(pageRepeatDelayRef.current);
      pageRepeatDelayRef.current = null;
    }
    if (pageRepeatIntervalRef.current !== null) {
      window.clearInterval(pageRepeatIntervalRef.current);
      pageRepeatIntervalRef.current = null;
    }
  };

  useEffect(() => stopPageRepeat, []);

  const readSummary = async () => {
    setDetecting(true);
    setError(null);
    try {
      const res = await api.post<{ chapters: ChapterSuggestion[] }>(`/api/books/${book._id}/summary/detect`);
      setPreviewPage(summaryPage);
      setEditingIdx(null);
      setSuggestions(res.data.chapters);
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error;
      setError(msg ?? t('Failed to read the summary page'));
    } finally {
      setDetecting(false);
    }
  };

  const removeSuggestion = (idx: number) =>
    setSuggestions(prev => (prev ? prev.filter((_, i) => i !== idx) : prev));

  const pageOf = (s: ChapterSuggestion) => (Number.isFinite(s.page) ? s.page : 1);

  // Re-check whether the chapter title actually appears on a given page's OCR text.
  // Keeps the green "found" marker live as the page is moved or the title is edited.
  const locateTitleOnPage = (title: string, page: number): { startChar: number; found: boolean } => {
    const needle = title.trim();
    if (!needle) return { startChar: 0, found: false };
    const m = findFlexible(pageText(page), needle);
    return m ? { startChar: m.index, found: true } : { startChar: 0, found: false };
  };

  const withFoundAt = (s: ChapterSuggestion, page: number): ChapterSuggestion => {
    const np = Math.max(1, page);
    return { ...s, page: np, ...locateTitleOnPage(s.title, np) };
  };

  const setTitle = (idx: number, title: string) =>
    setSuggestions(prev =>
      prev ? prev.map((s, i) => (i === idx ? { ...s, title, ...locateTitleOnPage(title, pageOf(s)) } : s)) : prev);

  // Two book pages per scanned sheet → the table-of-contents page is ~twice the
  // file page, so halving maps printed numbers onto the actual pages.
  const halveAllPages = () =>
    setSuggestions(prev => (prev ? prev.map(s => withFoundAt(s, Math.round(pageOf(s) / 2))) : prev));

  const shiftAllPages = (delta: number) =>
    setSuggestions(prev => (prev ? prev.map(s => withFoundAt(s, pageOf(s) + delta)) : prev));

  const stepSuggestionPage = (idx: number, delta: number) => {
    const current = suggestionsRef.current?.[idx];
    if (!current) return;
    const np = Math.max(1, pageOf(current) + delta);
    const next = suggestionsRef.current?.map((s, i) => (i === idx ? withFoundAt(s, np) : s)) ?? null;
    suggestionsRef.current = next;
    setSuggestions(next);
    setPreviewPage(Math.min(previewTotal, np));
  };

  const startPageRepeat = (idx: number, delta: number) => {
    stopPageRepeat();
    stepSuggestionPage(idx, delta);
    pageRepeatDelayRef.current = window.setTimeout(() => {
      stepSuggestionPage(idx, delta);
      pageRepeatIntervalRef.current = window.setInterval(() => stepSuggestionPage(idx, delta), 75);
    }, 350);
  };

  // Only import suggestions whose chosen page falls within the reading range —
  // titles read off the summary page that land outside it are dropped, not clamped in.
  const inReadingRange = (p: number) => p >= book.firstPage && p <= book.lastPage;

  const applySuggestions = () => {
    if (!suggestions) return;
    const next: Row[] = suggestions.filter(s => s.title.trim() && inReadingRange(pageOf(s))).map(s => {
      const startPage = clampPage(s.page);
      // When the AI located the title we keep its exact offset as the search needle;
      // an edited page invalidates that, so fall back to the title text.
      const label = s.found ? (wordAtOffset(pageText(startPage), s.startChar) || s.title.trim()) : s.title.trim();
      return { title: s.title.trim(), startPage, label };
    });
    setRows(next);
    persist(next);
    setSuggestions(null);
  };

  const clampPage = (p: number) =>
    Math.min(book.lastPage, Math.max(book.firstPage, Math.round(p) || book.firstPage));

  const locate = (r: Row): { startChar: number; found: boolean } => {
    const needle = r.label.trim();
    if (!needle) return { startChar: 0, found: true };
    const m = findFlexible(pageText(r.startPage), needle);
    return { startChar: m ? m.index : 0, found: !!m };
  };

  const toPayload = (list: Row[]) =>
    list.filter(r => r.title.trim()).map(r => ({
      title: r.title.trim(),
      startPage: clampPage(r.startPage),
      startChar: locate(r).startChar,
    }));

  const persist = (list: Row[]): Promise<void> => {
    const payload = toPayload(list);
    if (!payload.length) return Promise.resolve();
    return dispatch(updateChapters({ bookId: book._id, chapters: payload })).unwrap().catch(() => {});
  };

  const update = (idx: number, patch: Partial<Row>) =>
    setRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const blurSave = () => persist(rows);
  const addChapter = () => setRows(prev => [...prev, { title: '', startPage: book.firstPage, label: '' }]);
  const removeChapter = (idx: number) => {
    const next = rows.filter((_, i) => i !== idx);
    setRows(next);
    persist(next);
  };

  const handleConfirm = async () => {
    setError(null);
    try {
      await onConfirm(toPayload(rows));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to confirm chapters'));
    }
  };

  useImperativeHandle(ref, () => ({ submit: handleConfirm, save: () => persist(rows) }));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-gray-100">{t('Review chapters')}</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            {t('Set each chapter\'s name, the page it starts on, and the text that begins it (pages {from}–{to}).', { from: book.firstPage, to: book.lastPage })}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors disabled:opacity-40"
            onClick={readSummary}
            disabled={detecting}
            title={t('Re-read summary page with AI')}
            aria-label={t('Re-read summary page with AI')}
          >
            {detecting ? (
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
          </button>
          <button
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
            onClick={() => setShowSummary(true)}
            title={t('View summary page')}
            aria-label={t('View summary page')}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </button>
          <button
            className="w-8 h-8 rounded-lg flex items-center justify-center border-2 border-amber-600/60 text-amber-400 hover:bg-amber-600/15 hover:border-amber-500 transition-colors"
            onClick={addChapter}
            title={t('Add chapter')}
            aria-label={t('Add chapter')}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-300">{error}</div>
      )}

      <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
        {rows.map((c, idx) => {
          const nextStart  = rows[idx + 1]?.startPage;
          const endPage    = nextStart || book.lastPage;
          const hasPage    = Number.isFinite(c.startPage);
          const outOfRange = hasPage && (c.startPage < book.firstPage || c.startPage > book.lastPage);
          const { startChar, found } = locate(c);
          const hasLabel   = c.label.trim().length > 0;
          const pageTxt    = pageText(c.startPage);
          const excerpt    = pageTxt ? pageTxt.slice(startChar, startChar + 300) : '';
          return (
            <div
              key={idx}
              className={`rounded-lg border p-4 space-y-3 ${
                hasLabel && !found ? 'border-red-800 bg-red-950/20' : 'border-gray-700 bg-gray-800/40'
              }`}
            >
              <div className="flex gap-2 items-start">
                <div className="flex-1 space-y-2">
                  <input
                    className="input w-full"
                    value={c.title}
                    onChange={e => update(idx, { title: e.target.value })}
                    onBlur={blurSave}
                    placeholder={t('Chapter name…')}
                  />

                  <div className="flex items-center gap-2 text-sm">
                    <label className="text-gray-400">{t('Starts on page')}</label>
                    <input
                      type="number"
                      className="input w-24"
                      min={book.firstPage}
                      max={book.lastPage}
                      value={hasPage ? c.startPage : ''}
                      onChange={e => update(idx, { startPage: e.target.value === '' ? NaN : parseInt(e.target.value, 10) })}
                      onBlur={() => { update(idx, { startPage: clampPage(c.startPage) }); blurSave(); }}
                    />
                    <span className="text-xs text-gray-500">
                      {outOfRange ? t('out of range ({from}–{to})', { from: book.firstPage, to: book.lastPage }) : t('pages {from}–{to}', { from: hasPage ? c.startPage : '?', to: endPage })}
                    </span>
                  </div>

                  <div className="relative">
                    <input
                      className="input w-full pr-6"
                      value={c.label}
                      onChange={e => update(idx, { label: e.target.value })}
                      onBlur={blurSave}
                      placeholder={t('Text that starts this chapter on the page (optional)…')}
                    />
                    {hasLabel && (
                      <span className={`absolute right-2 top-1/2 -translate-y-1/2 text-xs ${found ? 'text-green-400' : 'text-red-400'}`}>
                        {found ? '✓' : '✗'}
                      </span>
                    )}
                  </div>

                  {hasLabel && !found && (
                    <p className="text-xs text-red-400">{t('Not found on page {page} — edit the label or page.', { page: hasPage ? c.startPage : '?' })}</p>
                  )}
                </div>

                <button
                  className="text-gray-600 hover:text-red-400 transition-colors mt-1 shrink-0"
                  onClick={() => removeChapter(idx)}
                  aria-label={t('Remove chapter')}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="rounded-md bg-gray-900/60 border border-gray-800 p-2.5">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-[11px] uppercase tracking-wide text-gray-600 flex-1 min-w-0 truncate">
                    {t('Page {page}', { page: hasPage ? c.startPage : '?' })}{hasLabel && found ? t(' · from "{label}"', { label: c.label.trim() }) : ''}
                  </p>
                  {onOpenPage && hasPage && !outOfRange && (
                    <button
                      className="shrink-0 text-gray-500 hover:text-amber-300 transition-colors"
                      onClick={() => onOpenPage(c.startPage)}
                      title={t('Open page {page} fullscreen', { page: c.startPage })}
                      aria-label={t('Open page {page} fullscreen', { page: c.startPage })}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
                      </svg>
                    </button>
                  )}
                </div>
                {outOfRange ? (
                  <p className="text-xs text-red-400">{t('Page out of range ({from}–{to}).', { from: book.firstPage, to: book.lastPage })}</p>
                ) : excerpt ? (
                  <p className="text-xs text-gray-400 line-clamp-3 whitespace-pre-wrap">{highlight(excerpt, hasLabel && found ? c.label.trim() : '')}</p>
                ) : (
                  <p className="text-xs text-gray-600 italic">{t('No text on this page.')}</p>
                )}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="text-sm text-gray-500">{t('No chapters yet. Click the')} <strong>+</strong> {t('button to create one.')}</p>
        )}
      </div>

      {suggestions !== null && (
        <div
          className="fixed inset-0 z-50 bg-gray-950/80 backdrop-blur flex items-center justify-center p-4"
          onClick={() => setSuggestions(null)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[1040px] max-w-[96vw] h-[680px] max-h-[92vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800 shrink-0">
              <h2 className="font-semibold text-gray-100">{t('Chapters')}</h2>
              <button
                className="text-xs font-medium px-2.5 py-1 rounded-full bg-gray-800 text-gray-300 hover:bg-amber-600/20 hover:text-amber-300 transition-colors"
                onClick={() => setPreviewPage(Math.min(previewTotal, Math.max(1, summaryPage)))}
                title={t('Go to the summary page in the preview')}
              >
                {t('Summary · p.{page}', { page: summaryPage })}
              </button>
              <div className="flex-1" />
              <button
                className="w-8 h-8 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
                onClick={() => setSuggestions(null)}
                title={t('Close')}
                aria-label={t('Close')}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 min-h-0 flex">
              {/* Editable chapter list */}
              <div className="flex flex-col min-h-0 w-[30rem] max-w-full shrink-0 md:border-r border-gray-800">
                <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-800 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">{t('All pages')}</span>
                    <div className="flex items-center rounded-lg border border-gray-700 overflow-hidden">
                      <button
                        className="px-2 py-1 text-gray-300 hover:bg-gray-800 disabled:opacity-40 transition-colors"
                        onClick={() => shiftAllPages(-1)}
                        disabled={suggestions.length === 0}
                        title={t('Shift every page back by one')}
                        aria-label={t('Shift every page back by one')}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                      <button
                        className="px-3 py-1 font-semibold text-gray-200 hover:bg-gray-800 disabled:opacity-40 border-x border-gray-700 transition-colors"
                        onClick={halveAllPages}
                        disabled={suggestions.length === 0}
                        title={t('Halve every page (two book pages per scanned page)')}
                        aria-label={t('Halve every page')}
                      >
                        ½
                      </button>
                      <button
                        className="px-2 py-1 text-gray-300 hover:bg-gray-800 disabled:opacity-40 transition-colors"
                        onClick={() => shiftAllPages(1)}
                        disabled={suggestions.length === 0}
                        title={t('Shift every page forward by one')}
                        aria-label={t('Shift every page forward by one')}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <span className="text-xs text-gray-500">{t('Click a title to edit')}</span>
                </div>

                {suggestions.length === 0 ? (
                  <p className="px-5 py-8 text-sm text-gray-500 text-center">
                    {t('No chapters could be read from the summary page.')}
                  </p>
                ) : (
                  <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-gray-800/70">
                    {suggestions.map((s, i) => {
                      return (
                        <div
                          key={i}
                          className="flex items-center gap-2 px-3 py-2 hover:bg-gray-800/40"
                        >
                          <div className="flex-1 min-w-0">
                            {editingIdx === i ? (
                              <input
                                autoFocus
                                className="input text-sm py-1"
                                value={s.title}
                                onChange={e => setTitle(i, e.target.value)}
                                onBlur={() => setEditingIdx(null)}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setEditingIdx(null); }}
                                placeholder={t('Chapter title…')}
                              />
                            ) : (
                              <button
                                className={`w-full text-left text-sm line-clamp-2 leading-tight px-1 py-0.5 rounded hover:bg-gray-800/60 transition-colors ${s.found ? 'text-green-300' : 'text-gray-200'}`}
                                onClick={() => setEditingIdx(i)}
                                title={s.title.trim() || t('Untitled — click to edit')}
                              >
                                {s.title.trim() || <span className="text-gray-500 italic">{t('Untitled')}</span>}
                              </button>
                            )}
                          </div>
                          <div className="flex items-center shrink-0">
                            <button
                              className="w-6 h-7 rounded-l flex items-center justify-center text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
                              onPointerDown={e => {
                                if (e.button !== 0) return;
                                e.preventDefault();
                                e.currentTarget.setPointerCapture(e.pointerId);
                                startPageRepeat(i, -1);
                              }}
                              onPointerUp={e => {
                                stopPageRepeat();
                                if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                              }}
                              onPointerCancel={stopPageRepeat}
                              onBlur={stopPageRepeat}
                              onClick={e => { if (e.detail === 0) stepSuggestionPage(i, -1); }}
                              title={t('Page −1 and preview')}
                              aria-label={t('Page back by one')}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                              </svg>
                            </button>
                            <button
                              className="w-12 h-7 text-sm text-center tabular-nums text-gray-200 hover:text-amber-300 hover:bg-gray-800 transition-colors"
                              onClick={() => setPreviewPage(Math.min(previewTotal, Math.max(1, pageOf(s))))}
                              title={t('Go to this page in the preview')}
                            >
                              {Number.isFinite(s.page) ? s.page : '?'}
                            </button>
                            <button
                              className="w-6 h-7 rounded-r flex items-center justify-center text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
                              onPointerDown={e => {
                                if (e.button !== 0) return;
                                e.preventDefault();
                                e.currentTarget.setPointerCapture(e.pointerId);
                                startPageRepeat(i, 1);
                              }}
                              onPointerUp={e => {
                                stopPageRepeat();
                                if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                              }}
                              onPointerCancel={stopPageRepeat}
                              onBlur={stopPageRepeat}
                              onClick={e => { if (e.detail === 0) stepSuggestionPage(i, 1); }}
                              title={t('Page +1 and preview')}
                              aria-label={t('Page forward by one')}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                              </svg>
                            </button>
                          </div>
                          <button
                            className="text-gray-600 hover:text-red-400 transition-colors shrink-0"
                            onClick={() => removeSuggestion(i)}
                            aria-label={t('Remove chapter')}
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Book page preview, opens on the summary page */}
              <div className="hidden md:flex flex-1 min-w-0 min-h-0 p-3">
                <PagePreview
                  bookId={book._id}
                  totalPages={previewTotal}
                  page={previewPage}
                  onPageChange={setPreviewPage}
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-800 shrink-0">
              <button className="btn-secondary text-sm" onClick={() => setSuggestions(null)}>{t('Cancel')}</button>
              <button
                className="btn-primary text-sm"
                onClick={applySuggestions}
                disabled={suggestions.filter(s => s.title.trim() && inReadingRange(pageOf(s))).length === 0}
              >
                {t('Replace chapters')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSummary && (
        <div
          className="fixed inset-0 z-50 bg-gray-950/95 backdrop-blur flex flex-col"
          onClick={() => setShowSummary(false)}
        >
          <div className="flex items-center gap-4 px-6 py-4 border-b border-gray-800 shrink-0">
            <h2 className="font-semibold text-gray-100 flex-1">{t('Summary page · p.{page}', { page: summaryPage })}</h2>
            <button
              className="w-8 h-8 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
              onClick={() => setShowSummary(false)}
              title={t('Close (Esc)')}
              aria-label={t('Close')}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto flex justify-center p-6" onClick={e => e.stopPropagation()}>
            <img
              src={`/api/books/${book._id}/pages/${summaryPage}`}
              alt={t('Summary page {page}', { page: summaryPage })}
              className="max-w-full h-auto object-contain rounded-lg"
            />
          </div>
        </div>
      )}
    </div>
  );
});

export default ChapterReview;
