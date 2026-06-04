import { useState, forwardRef, useImperativeHandle } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../store';
import { updateChapters } from '../store/booksSlice';
import { Book } from '../types';

interface Props {
  book: Book;
  onConfirm: (chapters: { title: string; startPage: number; startChar: number }[]) => Promise<void>;
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

function highlight(excerpt: string, needle: string) {
  if (!needle) return <span>{excerpt}</span>;
  const i = excerpt.toLowerCase().indexOf(needle.toLowerCase());
  if (i === -1) return <span>{excerpt}</span>;
  return (
    <>
      {excerpt.slice(0, i)}
      <span className="font-semibold text-green-300 bg-green-950/60 rounded px-0.5">{excerpt.slice(i, i + needle.length)}</span>
      {excerpt.slice(i + needle.length)}
    </>
  );
}

const ChapterReview = forwardRef<ChapterReviewHandle, Props>(function ChapterReview({ book, onConfirm }, ref) {
  const dispatch = useDispatch<AppDispatch>();

  const pageText = (page: number) => book.ocrPages.find(p => p.page === page)?.text?.trim() ?? '';

  const [rows, setRows] = useState<Row[]>(() =>
    book.chapters.map(c => ({
      title: c.title,
      startPage: c.startPage,
      label: wordAtOffset(pageText(c.startPage), c.startChar ?? 0),
    }))
  );
  const [error, setError] = useState<string | null>(null);

  const clampPage = (p: number) =>
    Math.min(book.lastPage, Math.max(book.firstPage, Math.round(p) || book.firstPage));

  const locate = (r: Row): { startChar: number; found: boolean } => {
    const needle = r.label.trim();
    if (!needle) return { startChar: 0, found: true };
    const idx = pageText(r.startPage).toLowerCase().indexOf(needle.toLowerCase());
    return { startChar: idx >= 0 ? idx : 0, found: idx >= 0 };
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
      setError(err instanceof Error ? err.message : 'Failed to confirm chapters');
    }
  };

  useImperativeHandle(ref, () => ({ submit: handleConfirm, save: () => persist(rows) }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-gray-100">Review chapters</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Set each chapter's name, the page it starts on, and the text that begins it (pages {book.firstPage}–{book.lastPage}).
          </p>
        </div>
        <button className="btn-secondary text-sm" onClick={addChapter}>+ Add</button>
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
                    placeholder="Chapter name…"
                  />

                  <div className="flex items-center gap-2 text-sm">
                    <label className="text-gray-400">Starts on page</label>
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
                      {outOfRange ? `out of range (${book.firstPage}–${book.lastPage})` : `pages ${hasPage ? c.startPage : '?'}–${endPage}`}
                    </span>
                  </div>

                  <div className="relative">
                    <input
                      className="input w-full pr-6"
                      value={c.label}
                      onChange={e => update(idx, { label: e.target.value })}
                      onBlur={blurSave}
                      placeholder="Text that starts this chapter on the page (optional)…"
                    />
                    {hasLabel && (
                      <span className={`absolute right-2 top-1/2 -translate-y-1/2 text-xs ${found ? 'text-green-400' : 'text-red-400'}`}>
                        {found ? '✓' : '✗'}
                      </span>
                    )}
                  </div>

                  {hasLabel && !found && (
                    <p className="text-xs text-red-400">Not found on page {hasPage ? c.startPage : '?'} — edit the label or page.</p>
                  )}
                </div>

                <button
                  className="text-gray-600 hover:text-red-400 transition-colors mt-1 shrink-0"
                  onClick={() => removeChapter(idx)}
                  aria-label="Remove chapter"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="rounded-md bg-gray-900/60 border border-gray-800 p-2.5">
                <p className="text-[11px] uppercase tracking-wide text-gray-600 mb-1">
                  Page {hasPage ? c.startPage : '?'}{hasLabel && found ? ` · from "${c.label.trim()}"` : ''}
                </p>
                {outOfRange ? (
                  <p className="text-xs text-red-400">Page out of range ({book.firstPage}–{book.lastPage}).</p>
                ) : excerpt ? (
                  <p className="text-xs text-gray-400 line-clamp-3 whitespace-pre-wrap">{highlight(excerpt, hasLabel && found ? c.label.trim() : '')}</p>
                ) : (
                  <p className="text-xs text-gray-600 italic">No text on this page.</p>
                )}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="text-sm text-gray-500">No chapters yet. Click <strong>+ Add</strong> to create one.</p>
        )}
      </div>
    </div>
  );
});

export default ChapterReview;
