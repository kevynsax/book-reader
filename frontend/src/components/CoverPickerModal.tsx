import { useState, useRef } from 'react';
import { Book } from '../types';
import { api } from '../api/booksApi';

interface Props {
  book: Book;
  onClose: () => void;
}

type Mode = 'file' | 'page';

export default function CoverPickerModal({ book, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const [mode,      setMode]      = useState<Mode>('file');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [preview,   setPreview]   = useState<string | null>(null);
  const [pageNum,   setPageNum]   = useState(book.coverPage || 1);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const hasPages = (book.totalPages ?? 0) > 0;

  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) { setError('Please choose an image file.'); return; }
    setError(null);
    setImageFile(file);
    setPreview(URL.createObjectURL(file));
    setMode('file');
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (mode === 'file' && imageFile) {
        const fd = new FormData();
        fd.append('image', imageFile);
        await api.put(`/api/books/${book._id}/cover`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      } else if (mode === 'page') {
        await api.put(`/api/books/${book._id}/cover/page`, { page: pageNum });
      }
      // The cover change is broadcast over the socket (book:update → coverVersion bump),
      // which busts the <img> cache automatically.
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update cover');
    } finally {
      setSaving(false);
    }
  };

  const canSave = (mode === 'file' && !!imageFile) || (mode === 'page' && hasPages);

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-gray-900 rounded-2xl border border-gray-700 w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="font-semibold text-gray-100">Change cover</h2>
          <button className="text-gray-500 hover:text-gray-300 text-xl leading-none" onClick={onClose}>×</button>
        </div>

        <div className="p-5 space-y-4">
          {error && <p className="text-sm text-red-400">{error}</p>}

          {/* Upload section */}
          <div>
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-2">Upload image</p>
            <div
              className={`border-2 border-dashed rounded-xl overflow-hidden cursor-pointer transition-colors flex items-center justify-center min-h-36
                ${mode === 'file' && imageFile ? 'border-amber-600' : 'border-gray-700 hover:border-amber-600/60'}`}
              onClick={() => fileRef.current?.click()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
              onDragOver={e => e.preventDefault()}
            >
              {preview ? (
                <img src={preview} alt="New cover" className="max-h-48 w-full object-contain" />
              ) : (
                <div className="text-center py-5 px-4">
                  <svg className="w-8 h-8 text-gray-600 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <p className="text-gray-400 text-sm">Drop or <span className="text-amber-500">browse</span></p>
                  <p className="text-gray-600 text-xs mt-1">JPG · PNG · WebP</p>
                </div>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          </div>

          {/* Divider */}
          {hasPages && (
            <>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-gray-800" />
                <span className="text-xs text-gray-600">or select a page</span>
                <div className="flex-1 h-px bg-gray-800" />
              </div>

              {/* Page selector */}
              <div>
                <div
                  className={`rounded-xl overflow-hidden border-2 transition-colors ${mode === 'page' ? 'border-amber-600' : 'border-gray-800 hover:border-gray-700'}`}
                  onClick={() => setMode('page')}
                >
                  <div className="relative group cursor-pointer bg-gray-800 flex items-center justify-center min-h-32">
                    <img
                      key={pageNum}
                      src={`/api/books/${book._id}/pages/${pageNum}`}
                      alt={`Page ${pageNum}`}
                      className="max-h-40 w-full object-contain"
                    />

                    {/* Carousel arrows */}
                    <button
                      className="absolute left-0 top-0 h-full w-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-r from-black/50 to-transparent disabled:!opacity-0"
                      onClick={e => { e.stopPropagation(); setMode('page'); setPageNum(p => Math.max(1, p - 1)); }}
                      disabled={pageNum <= 1}
                    >
                      <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <button
                      className="absolute right-0 top-0 h-full w-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-l from-black/50 to-transparent disabled:!opacity-0"
                      onClick={e => { e.stopPropagation(); setMode('page'); setPageNum(p => Math.min(book.totalPages, p + 1)); }}
                      disabled={pageNum >= book.totalPages}
                    >
                      <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>

                    <span className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-sm rounded-full px-2 py-0.5 text-xs text-white font-mono">
                      {pageNum} / {book.totalPages}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button className="btn-secondary flex-1 justify-center" onClick={onClose}>Cancel</button>
            <button className="btn-primary flex-1 justify-center" disabled={!canSave || saving} onClick={save}>
              {saving ? 'Saving…' : 'Set as cover'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
