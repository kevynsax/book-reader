import { useState, forwardRef, useImperativeHandle } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../store';
import { updateChapters } from '../store/booksSlice';
import { Book } from '../types';

interface Props {
  book: Book;
  onConfirm: (chapters: { title: string; startPage: number }[]) => Promise<void>;
}

interface Row { title: string; startPage: number; }

export interface ChapterReviewHandle {
  submit: () => Promise<void>;
  save: () => Promise<void>;
}

const ChapterReview = forwardRef<ChapterReviewHandle, Props>(function ChapterReview({ book, onConfirm }, ref) {
  const dispatch = useDispatch<AppDispatch>();

  const pageText = (page: number) => book.ocrPages.find(p => p.page === page)?.text?.trim() ?? '';

  const [rows, setRows] = useState<Row[]>(() =>
    book.chapters.map(c => ({ title: c.title, startPage: c.startPage }))
  );
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const clampPage = (p: number) =>
    Math.min(book.lastPage, Math.max(book.firstPage, Math.round(p) || book.firstPage));

  const persist = (list: Row[]): Promise<void> => {
    const valid = list.filter(r => r.title.trim());
    if (!valid.length) return Promise.resolve();
    return dispatch(updateChapters({
      bookId: book._id,
      chapters: valid.map(r => ({ title: r.title.trim(), startPage: clampPage(r.startPage) })),
    })).unwrap().catch(() => {});
  };

  const update = (idx: number, patch: Partial<Row>) =>
    setRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const blurSave = () => persist(rows);

  const addChapter = () => setRows(prev => [...prev, { title: '', startPage: book.firstPage }]);

  const removeChapter = (idx: number) => {
    const next = rows.filter((_, i) => i !== idx);
    setRows(next);
    persist(next);
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(rows.filter(r => r.title.trim()).map(r => ({ title: r.title.trim(), startPage: r.startPage })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm chapters');
    } finally {
      setSubmitting(false);
    }
  };

  useImperativeHandle(ref, () => ({ submit: handleConfirm, save: () => persist(rows) }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-gray-100">Review chapters</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Set each chapter's name and the page it starts on (pages {book.firstPage}–{book.lastPage}).
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
          const endPage    = nextStart ? nextStart - 1 : book.lastPage;
          const hasPage    = Number.isFinite(c.startPage);
          const outOfRange = hasPage && (c.startPage < book.firstPage || c.startPage > book.lastPage);
          const badOrder   = hasPage && Number.isFinite(endPage) && endPage < c.startPage;
          const preview    = pageText(c.startPage);
          return (
            <div key={idx} className="rounded-lg border border-gray-700 bg-gray-800/40 p-4 space-y-3">
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
                    <span className={`text-xs ${badOrder ? 'text-red-400' : 'text-gray-500'}`}>
                      {!hasPage ? 'enter a page' : badOrder ? 'starts after the next chapter' : `pages ${c.startPage}–${endPage}`}
                    </span>
                  </div>
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
                <p className="text-[11px] uppercase tracking-wide text-gray-600 mb-1">Page {c.startPage}</p>
                {outOfRange ? (
                  <p className="text-xs text-red-400">Page out of range ({book.firstPage}–{book.lastPage}).</p>
                ) : preview ? (
                  <p className="text-xs text-gray-400 line-clamp-3 whitespace-pre-wrap">{preview.slice(0, 300)}</p>
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
