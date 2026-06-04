import { useState, useEffect, useCallback } from 'react';
import { OcrPage } from '../types';
import { api } from '../api/booksApi';

interface Props {
  bookId: string;
  ocrPages: OcrPage[];
  onTextSaved?: () => void;
}

interface PageViewProps {
  bookId: string;
  page: OcrPage;
  large?: boolean;
  onTextSaved?: () => void;
}

function PageView({ bookId, page, large, onTextSaved }: PageViewProps) {
  const [editText, setEditText] = useState(page.text ?? '');
  const [dirty,    setDirty]    = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [saveOk,   setSaveOk]   = useState(false);

  useEffect(() => {
    setEditText(page.text ?? '');
    setDirty(false);
    setSaveOk(false);
  }, [page.page, page.text]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await api.put(`/api/books/${bookId}/pages/${page.page}/text`, { text: editText });
      setDirty(false);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2000);
      onTextSaved?.();
    } finally {
      setSaving(false);
    }
  }, [bookId, page.page, editText]);

  return (
    <div className={`grid grid-cols-2 gap-4 ${large ? 'flex-1 min-h-0' : ''}`}>
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <img
          key={page.page}
          src={`/api/books/${bookId}/pages/${page.page}`}
          alt={`Page ${page.page}`}
          className={`w-full block object-contain ${large ? 'h-[calc(100vh-10rem)]' : 'h-auto'}`}
          loading="lazy"
        />
      </div>
      <div className="flex flex-col gap-2">
        {page.status === 'processing' ? (
          <div className="flex-1 bg-gray-800/50 rounded-lg p-3 flex items-center">
            <span className="text-xs text-amber-400 animate-pulse">Reading page…</span>
          </div>
        ) : (
          <>
            <textarea
              className="input font-mono text-sm leading-relaxed resize-none flex-1"
              style={{ minHeight: 0 }}
              value={editText}
              onChange={e => { setEditText(e.target.value); setDirty(true); setSaveOk(false); }}
              onBlur={() => { if (dirty && editText.trim()) save(); }}
              spellCheck={false}
              placeholder="No text extracted for this page"
            />
            <div className="h-5 flex items-center gap-3">
              {saving  && <span className="text-xs text-gray-500">Saving…</span>}
              {saveOk  && <span className="text-xs text-green-400">✓ Saved</span>}
              {dirty && !saving && !saveOk && <span className="text-xs text-amber-400">Unsaved changes</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function TextReview({ bookId, ocrPages, onTextSaved }: Props) {
  const processed = ocrPages.filter(p => p.status === 'complete' || p.status === 'processing');
  const done      = ocrPages.filter(p => p.status === 'complete').length;
  const total     = ocrPages.length;
  const current   = ocrPages.find(p => p.status === 'processing');

  const [idx,        setIdx]        = useState(0);
  const [userMoved,  setUserMoved]  = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!userMoved && processed.length > 0) setIdx(processed.length - 1);
  }, [processed.length, userMoved]);

  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fullscreen]);

  if (processed.length === 0) return null;

  const page = processed[idx];
  const prev = () => { setUserMoved(true); setIdx(i => Math.max(0, i - 1)); };
  const next = () => { setUserMoved(true); setIdx(i => Math.min(processed.length - 1, i + 1)); };

  const Nav = ({ large }: { large?: boolean }) => (
    <div className="flex items-center gap-2 shrink-0">
      <button
        className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
        onClick={prev} disabled={idx === 0}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <span className={`font-mono text-center text-gray-500 ${large ? 'text-sm w-20' : 'text-xs w-14'}`}>
        {idx + 1} / {processed.length}
      </span>
      <button
        className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 transition-colors"
        onClick={next} disabled={idx === processed.length - 1}
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
              title="Fullscreen"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
              </svg>
            </button>
          </div>
        </div>

        <p className="text-xs text-gray-500">
          {done} of {total} pages processed
          {current && <span className="text-amber-400"> · reading page {current.page}…</span>}
        </p>

        <PageView bookId={bookId} page={page} onTextSaved={onTextSaved} />
      </div>

      {fullscreen && (
        <div className="fixed inset-0 z-50 bg-gray-950/95 backdrop-blur flex flex-col">
          <div className="flex items-center gap-4 px-6 py-4 border-b border-gray-800 shrink-0">
            <h2 className="font-semibold text-gray-100 flex-1">Reading pages</h2>
            <p className="text-xs text-gray-500">
              {done} of {total} pages
              {current && <span className="text-amber-400 ml-1">· reading page {current.page}…</span>}
            </p>
            {processed.length > 1 && <Nav large />}
            <button
              className="w-8 h-8 rounded flex items-center justify-center text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
              onClick={() => setFullscreen(false)}
              title="Close (Esc)"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex-1 min-h-0 px-6 py-4">
            <PageView bookId={bookId} page={page} large onTextSaved={onTextSaved} />
          </div>
        </div>
      )}
    </>
  );
}
