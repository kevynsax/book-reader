import { useState, useMemo, forwardRef, useImperativeHandle } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../store';
import { updateChapters } from '../store/booksSlice';
import { Book, OcrPage, ReviewChapter } from '../types';

interface Props {
  book: Book;
  onConfirm: (chapters: { title: string; startPage: number }[]) => Promise<void>;
}

function wordAtOffset(text: string, offset: number): string {
  const at = Math.max(0, Math.min(offset, text.length));
  // If the offset lands in the middle of a word (e.g. after page text was
  // edited and char offsets shifted), drop that partial fragment so we return
  // the next *whole* word rather than a truncated piece of one.
  const midWord = at > 0 && /\S/.test(text[at - 1] ?? '') && /\S/.test(text[at] ?? '');
  const rest = midWord ? text.slice(at).replace(/^\S+/, '') : text.slice(at);
  return rest.trimStart().match(/^\S+/)?.[0] ?? '';
}

function highlightExcerpt(excerpt: string, needle: string) {
  const i = excerpt.toLowerCase().indexOf(needle.toLowerCase());
  if (i === -1) return <span className="italic">{excerpt}</span>;
  return (
    <>
      <span className="italic">{excerpt.slice(0, i)}</span>
      <span className="not-italic font-semibold text-green-300 bg-green-950/60 rounded px-0.5">
        {excerpt.slice(i, i + needle.length)}
      </span>
      <span className="italic">{excerpt.slice(i + needle.length)}</span>
    </>
  );
}

function findInText(title: string, pages: OcrPage[]): { found: boolean; foundPage: number | null; charOffset: number; excerpt: string | null } {
  const needle = title.toLowerCase().trim();
  if (!needle) return { found: false, foundPage: null, charOffset: 0, excerpt: null };

  for (const p of pages) {
    const haystack = p.text.toLowerCase();
    const idx = haystack.indexOf(needle);
    if (idx !== -1) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(p.text.length, idx + needle.length + 60);
      return {
        found: true,
        foundPage: p.page,
        charOffset: idx,
        excerpt: '…' + p.text.slice(start, end).trim() + '…',
      };
    }
  }
  return { found: false, foundPage: null, charOffset: 0, excerpt: null };
}

export interface ChapterReviewHandle {
  submit: () => Promise<void>;
}

const ChapterReview = forwardRef<ChapterReviewHandle, Props>(function ChapterReview({ book, onConfirm }, ref) {
  const dispatch       = useDispatch<AppDispatch>();
  const completedPages = useMemo(
    () => book.ocrPages.filter(p => p.status === 'complete'),
    [book.ocrPages]
  );

  const [chapters, setChapters] = useState<ReviewChapter[]>(() =>
    book.chapters.map(c => {
      const pageText = book.ocrPages.find(p => p.page === c.startPage)?.text ?? '';
      return {
        title:     c.title,
        // The label is the exact text that starts the chapter: the word at the
        // saved char index on the saved page — not the (often non-verbatim) title.
        label:     wordAtOffset(pageText, c.startChar ?? 0),
        startPage: c.startPage,
        startChar: c.startChar ?? 0,
        endPage:   book.lastPage,
        found:     false,
        foundPage: null,
        excerpt:   null,
      };
    })
  );
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const searched = useMemo<ReviewChapter[]>(() =>
    chapters.map(c => {
      // Prefer the chapter's own saved page so a common starting word resolves
      // there instead of its first occurrence earlier in the book.
      const ordered = [...completedPages].sort((a, b) =>
        a.page === c.startPage ? -1 : b.page === c.startPage ? 1 : a.page - b.page
      );
      const result = findInText(c.label, ordered);
      return {
        ...c,
        found:     result.found,
        foundPage: result.foundPage,
        excerpt:   result.excerpt,
        startPage: result.foundPage ?? c.startPage,
        startChar: result.found ? result.charOffset : c.startChar,
      };
    }),
    [chapters, completedPages]
  );

  const searchedWithEnds = useMemo<ReviewChapter[]>(() =>
    searched.map((c, idx) => ({
      ...c,
      endPage: searched[idx + 1]?.startPage
        ? searched[idx + 1].startPage - 1
        : book.lastPage,
    })),
    [searched, book.lastPage]
  );

  const updateField = (idx: number, patch: Partial<ReviewChapter>) => {
    setChapters(prev => prev.map((c, i) => i === idx ? { ...c, ...patch } : c));
  };

  const blurSave = () => {
    const valid = searchedWithEnds.filter(c => c.title.trim());
    if (!valid.length) return;
    dispatch(updateChapters({
      bookId: book._id,
      chapters: valid.map(c => ({ title: c.title, startPage: c.startPage, startChar: c.startChar })),
    })).catch(() => {});
  };

  const addChapter = () => {
    setChapters(prev => [...prev, {
      title:     '',
      label:     '',
      startPage: book.firstPage,
      startChar: 0,
      endPage:   book.lastPage,
      found:     false,
      foundPage: null,
      excerpt:   null,
    }]);
  };

  const removeChapter = (idx: number) => {
    setChapters(prev => prev.filter((_, i) => i !== idx));
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(searchedWithEnds.map(c => ({
        title: c.title,
        startPage: c.startPage,
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm chapters');
    } finally {
      setSubmitting(false);
    }
  };

  useImperativeHandle(ref, () => ({ submit: handleConfirm }));

  const allFound = searchedWithEnds.every(c => c.found || !c.label.trim());

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-gray-100">Review chapters</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Give each chapter a name, then set the label to the exact text that starts it in the book.
          </p>
        </div>
        <button className="btn-secondary text-sm" onClick={addChapter}>+ Add</button>
      </div>

      {error && (
        <div className="p-3 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-300">{error}</div>
      )}

      <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
        {searchedWithEnds.map((c, idx) => (
          <div
            key={idx}
            className={`rounded-lg border p-4 space-y-2 ${
              c.found ? 'border-green-800 bg-green-950/20' : 'border-red-800 bg-red-950/20'
            }`}
          >
            <div className="flex gap-2 items-start">
              <div className="flex-1 space-y-2">
                {/* Chapter name */}
                <input
                  className="input w-full"
                  value={c.title}
                  onChange={e => updateField(idx, { title: e.target.value })}
                  onBlur={blurSave}
                  placeholder="Chapter name…"
                />
                {/* Label that marks the start */}
                <div className="relative">
                  <input
                    className="input w-full pr-6"
                    value={c.label}
                    onChange={e => updateField(idx, { label: e.target.value })}
                    onBlur={blurSave}
                    placeholder="Text that starts this chapter in the book…"
                  />
                  {c.label.trim() && (
                    <span className={`absolute right-2 top-1/2 -translate-y-1/2 text-xs ${
                      c.found ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {c.found ? '✓' : '✗'}
                    </span>
                  )}
                </div>

                {c.found && c.foundPage !== null && (
                  <div className="text-xs text-green-400 flex items-center gap-1">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    Found on page {c.foundPage} · pages {c.startPage}–{c.endPage}
                  </div>
                )}
                {!c.found && c.label.trim() && (
                  <div className="text-xs text-red-400 flex items-center gap-1">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    Not found — edit the label to match the text in the book
                  </div>
                )}
                {c.excerpt && (
                  <p className="text-xs text-gray-500 line-clamp-2">
                    {highlightExcerpt(c.excerpt, c.label)}
                  </p>
                )}
              </div>
              <button
                className="text-gray-600 hover:text-red-400 transition-colors mt-1 shrink-0"
                onClick={() => removeChapter(idx)}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>

      {!allFound && (
        <p className="text-sm text-yellow-400">
          Some labels weren't found. You can still generate, but those chapters may not have accurate page ranges.
        </p>
      )}
    </div>
  );
});

export default ChapterReview;
