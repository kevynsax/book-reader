import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../store';
import { reprocessBook } from '../store/booksSlice';
import { Book } from '../types';
import PagePreview from './PagePreview';
import { t } from '../i18n';

type PageRole = 'cover' | 'summary' | 'first' | 'last';

const ROLES: { role: PageRole; label: string }[] = [
  { role: 'cover',   label: 'Cover'      },
  { role: 'summary', label: 'Summary'    },
  { role: 'first',   label: 'First page' },
  { role: 'last',    label: 'Last page'  },
];

interface Props {
  book: Book;
  onClose: () => void;
}

export default function ReimportModal({ book, onClose }: Props) {
  const dispatch = useDispatch<AppDispatch>();
  const totalPages = book.totalPages || 1;

  const [coverPage,    setCoverPage]    = useState(book.coverPage || 1);
  const [summaryPages, setSummaryPages] = useState<number[]>(book.summaryPages?.length ? book.summaryPages : []);
  const [firstPage,    setFirstPage]    = useState(book.firstPage || 1);
  const [lastPage,     setLastPage]     = useState(book.lastPage  || totalPages);
  const [currentPage,  setCurrentPage]  = useState(book.coverPage || 1);
  const [submitting,   setSubmitting]   = useState(false);

  const isActive = (role: PageRole) =>
    role === 'summary' ? summaryPages.includes(currentPage)
                       : ({ cover: coverPage, first: firstPage, last: lastPage }[role]) === currentPage;
  const roleLabel = (role: PageRole): string =>
    role === 'summary' ? summaryPages.join(', ') : String({ cover: coverPage, first: firstPage, last: lastPage }[role]);

  const setAs = (role: PageRole) => {
    if (role === 'cover')   { setCoverPage(currentPage);   return; }
    if (role === 'summary') {
      setSummaryPages(prev => prev.includes(currentPage)
        ? prev.filter(p => p !== currentPage)
        : [...prev, currentPage].sort((a, b) => a - b));
      return;
    }
    if (role === 'first') {
      if (lastPage > 0 && currentPage > lastPage) { setFirstPage(lastPage); setLastPage(currentPage); }
      else                                         setFirstPage(currentPage);
      return;
    }
    // role === 'last'
    if (firstPage > 0 && currentPage < firstPage) { setFirstPage(currentPage); setLastPage(firstPage); }
    else                                           setLastPage(currentPage);
  };

  const submit = async () => {
    if (summaryPages.length === 0) return;
    setSubmitting(true);
    try {
      await dispatch(reprocessBook({
        bookId: book._id,
        config: { coverPage, summaryPages, firstPage, lastPage },
      })).unwrap();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-2xl border border-gray-700 w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-gray-100">{t('Review pages & re-import')}</h2>
          <button className="text-gray-500 hover:text-gray-300" onClick={onClose}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-3 overflow-y-auto">
          <div className="grid grid-cols-2 gap-2">
            {ROLES.map(({ role, label }) => {
              const active = isActive(role);
              const val    = roleLabel(role);
              return (
                <button
                  key={role}
                  onClick={() => setAs(role)}
                  className={`rounded-2xl py-3 px-4 text-sm font-semibold border-2 transition-all text-left
                    ${active
                      ? 'bg-amber-600 border-amber-500 text-white'
                      : 'bg-amber-600/15 border-amber-600/50 text-amber-300 hover:bg-amber-600/25'}`}
                >
                  {t(label)}
                  {val && <span className="ml-2 text-xs opacity-70 font-normal">{t('p.{val}', { val })}</span>}
                  {role === 'summary' && <span className="block text-[11px] opacity-60 font-normal mt-0.5">{t('tap to add/remove')}</span>}
                </button>
              );
            })}
          </div>

          <div className="h-[420px]">
            <PagePreview
              bookId={book._id}
              totalPages={totalPages}
              page={currentPage}
              onPageChange={setCurrentPage}
            />
          </div>

          <button className="btn-primary w-full justify-center" disabled={submitting || summaryPages.length === 0} onClick={submit}>
            {submitting ? t('Restarting…') : t('Restart import')}
          </button>
        </div>
      </div>
    </div>
  );
}
