import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../store';
import { deleteBook } from '../store/booksSlice';
import { Book, BookStatus } from '../types';
import { bookVoices, trackFor, hasPlayableAudio } from '../lib/format';
import ConfirmDialog from './ConfirmDialog';

function formatDuration(totalSecs: number): string {
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

const STATUS_LABEL: Record<BookStatus, string> = {
  uploading: 'Uploading',
  splitting_pages: 'Splitting pages',
  extracting_cover: 'Extracting cover',
  reading_title: 'Reading title',
  ocr_processing: 'Reading pages',
  detecting_chapters: 'Detecting chapters',
  awaiting_chapter_review: 'Needs review',
  generating_audio: 'Generating audio',
  complete: 'Complete',
  error: 'Error',
};

const STATUS_CLASS: Record<BookStatus, string> = {
  uploading: 'badge-uploading',
  splitting_pages: 'badge-processing',
  extracting_cover: 'badge-processing',
  reading_title: 'badge-processing',
  ocr_processing: 'badge-processing',
  detecting_chapters: 'badge-processing',
  awaiting_chapter_review: 'badge-review',
  generating_audio: 'badge-audio',
  complete: 'badge-complete',
  error: 'badge-error',
};

export default function BookCard({ book }: { book: Book }) {
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  const canDelete = useSelector((s: RootState) => s.books.canDelete);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const isComplete   = book.status === 'complete';
  const canPlay      = isComplete || hasPlayableAudio(book);

  const primaryVoice = bookVoices(book)[0] ?? '';
  const readyDurations = book.chapters
    .map(c => trackFor(c, primaryVoice))
    .filter(t => t?.audioStatus === 'complete')
    .map(t => t?.audioDurationSecs ?? 0);
  const totalDurationSecs = readyDurations.reduce((s, d) => s + d, 0);
  let listenedSecs = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(`br_pos_${book._id}`) ?? 'null') as
      { chapterIdx: number; time: number } | null;
    if (saved) {
      listenedSecs = readyDurations
        .slice(0, saved.chapterIdx)
        .reduce((s, d) => s + d, 0) + (saved.time ?? 0);
    }
  } catch { }
  const remainingSecs = Math.max(0, totalDurationSecs - listenedSecs);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(true);
  };

  return (
    <div
      className="card cursor-pointer hover:border-gray-600 transition-colors group relative"
      onClick={() => navigate(canPlay ? `/books/${book._id}` : `/books/${book._id}/edit`)}
    >
      {canDelete && (
        <button
          className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-gray-800/80 flex items-center justify-center text-gray-500 hover:bg-red-700 hover:text-white transition-all opacity-0 group-hover:opacity-100"
          onClick={handleDelete}
          title="Delete book"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      )}

      <div className="aspect-[2/3] mb-4 rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center">
        {book.coverImagePath ? (
          <img
            src={`/api/books/${book._id}/cover?v=${book.coverVersion ?? 0}`}
            alt={book.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <svg className="w-12 h-12 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
              d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
        )}
      </div>

      <h3 className="font-semibold text-gray-100 truncate mb-2 group-hover:text-amber-400 transition-colors">
        {book.name || 'Untitled'}
      </h3>

      {!isComplete && (
        <div className="flex items-center justify-between mb-2">
          <span className={STATUS_CLASS[book.status]}>{STATUS_LABEL[book.status]}</span>
        </div>
      )}

      <p className="text-xs text-gray-500 mb-2">
        {totalDurationSecs > 0 && remainingSecs > 0 ? `${formatDuration(remainingSecs)} left` : null}
      </p>

      {book.status === 'error' && (
        <p className="text-xs text-red-400 truncate">{book.errorMessage}</p>
      )}

      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete book?"
          message={`"${book.name || 'Untitled'}" and all its audio will be permanently deleted.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => { setShowDeleteConfirm(false); dispatch(deleteBook(book._id)); }}
          onClose={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
