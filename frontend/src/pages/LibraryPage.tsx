import { useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import BookCard from '../components/BookCard';
import UploadWizard from '../components/UploadWizard';

export default function LibraryPage() {
  const { books, loading, error } = useSelector((s: RootState) => s.books);
  const [showUpload, setShowUpload] = useState(false);

  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg className="w-7 h-7 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            <h1 className="text-xl font-bold text-gray-100">Book Reader</h1>
          </div>
          <button className="btn-primary" onClick={() => setShowUpload(true)}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add book
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {loading && (
          <div className="text-center py-16 text-gray-500">Loading library…</div>
        )}

        {error && (
          <div className="p-4 bg-red-900/30 border border-red-800 rounded-lg text-red-300 mb-6">
            {error}
          </div>
        )}

        {!loading && books.length === 0 && (
          <div className="text-center py-24">
            <svg className="w-16 h-16 text-gray-700 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
                d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            <p className="text-gray-500 text-lg mb-2">No books yet</p>
            <p className="text-gray-600 text-sm mb-6">Upload a PDF to get started</p>
            <button className="btn-primary" onClick={() => setShowUpload(true)}>
              Add your first book
            </button>
          </div>
        )}

        {books.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {books.map(book => (
              <BookCard key={book._id} book={book} />
            ))}
          </div>
        )}
      </main>

      {showUpload && <UploadWizard onClose={() => setShowUpload(false)} />}
    </div>
  );
}
