import { useState, useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { UploadFormData } from '../../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href;

interface Props {
  data: UploadFormData;
  onChange: (patch: Partial<UploadFormData>) => void;
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
}

type PageRole = 'cover' | 'summary' | 'first' | 'last';

const ROLES: { role: PageRole; label: string }[] = [
  { role: 'cover',   label: 'Cover'      },
  { role: 'summary', label: 'Summary'    },
  { role: 'first',   label: 'First page' },
  { role: 'last',    label: 'Last page'  },
];

export default function Step2PageSelection({ data, onChange, onBack, onSubmit, submitting }: Props) {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

  const [pdf,         setPdf]         = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages,    setNumPages]    = useState(0);
  const [rendering,   setRendering]   = useState(false);

  useEffect(() => {
    if (!data.file) return;
    data.file.arrayBuffer().then(buf =>
      pdfjsLib.getDocument({ data: buf }).promise.then(doc => {
        setPdf(doc);
        setNumPages(doc.numPages);
        onChange({ coverPage: 1 });
      })
    );
  }, [data.file]);

  const renderPage = useCallback(async (pageNum: number) => {
    if (!pdf || !canvasRef.current) return;
    renderTaskRef.current?.cancel();
    setRendering(true);

    const page     = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const canvas   = canvasRef.current;
    const ctx      = canvas.getContext('2d')!;
    const maxW     = canvas.parentElement?.clientWidth ?? 400;
    const scale    = Math.min(maxW / viewport.width, 1.5);
    const scaled   = page.getViewport({ scale });

    canvas.width  = Math.ceil(scaled.width);
    canvas.height = Math.ceil(scaled.height);

    const task = page.render({ canvasContext: ctx, viewport: scaled });
    renderTaskRef.current = task;
    try { await task.promise; } catch { } finally { setRendering(false); }
  }, [pdf]);

  useEffect(() => { renderPage(currentPage); }, [renderPage, currentPage]);

  const getVal = (role: PageRole): number =>
    ({ cover: data.coverPage, summary: data.summaryPage, first: data.firstPage, last: data.lastPage }[role] ?? 0);

  const isSet    = (role: PageRole) => getVal(role) > 0;
  const isActive = (role: PageRole) => getVal(role) === currentPage;

  const setAs = (role: PageRole) => {
    if (role === 'cover')   { onChange({ coverPage: currentPage });   return; }
    if (role === 'summary') { onChange({ summaryPage: currentPage }); return; }
    if (role === 'first') {
      const last = data.lastPage;
      if (last > 0 && currentPage > last) onChange({ firstPage: last, lastPage: currentPage });
      else                                onChange({ firstPage: currentPage });
      return;
    }
    if (role === 'last') {
      const first = data.firstPage;
      if (first > 0 && currentPage < first) onChange({ firstPage: currentPage, lastPage: first });
      else                                  onChange({ lastPage: currentPage });
    }
  };

  const prevPage = () => setCurrentPage(p => Math.max(1, p - 1));
  const nextPage = () => setCurrentPage(p => Math.min(numPages, p + 1));

  const canCreate = isSet('cover') && isSet('summary') && isSet('first') && isSet('last');

  return (
    <div className="space-y-3">

      <div className="grid grid-cols-2 gap-2">
        {ROLES.map(({ role, label }) => {
          const set    = isSet(role);
          const active = isActive(role);
          const val    = getVal(role);
          return (
            <button
              key={role}
              onClick={() => setAs(role)}
              className={`
                rounded-2xl py-3 px-4 text-sm font-semibold border-2 transition-all text-left
                ${active
                  ? 'bg-amber-600 border-amber-500 text-white'
                  : set
                  ? 'bg-amber-600/15 border-amber-600/50 text-amber-300 hover:bg-amber-600/25'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-300'
                }
              `}
            >
              {label}
              {set && <span className="ml-2 text-xs opacity-70 font-normal">p.{val}</span>}
            </button>
          );
        })}
      </div>

      <div className="relative group bg-gray-800 rounded-xl overflow-hidden">

        <button
          className="absolute left-0 top-0 z-20 h-full w-10 flex items-center justify-center
                     opacity-0 group-hover:opacity-100 transition-opacity
                     bg-gradient-to-r from-black/50 to-transparent
                     disabled:!opacity-0"
          onClick={prevPage}
          disabled={currentPage <= 1}
        >
          <svg className="w-6 h-6 text-white drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <button
          className="absolute right-0 top-0 z-20 h-full w-10 flex items-center justify-center
                     opacity-0 group-hover:opacity-100 transition-opacity
                     bg-gradient-to-l from-black/50 to-transparent
                     disabled:!opacity-0"
          onClick={nextPage}
          disabled={currentPage >= numPages}
        >
          <svg className="w-6 h-6 text-white drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {rendering && (
          <div className="absolute inset-0 bg-gray-800/60 flex items-center justify-center z-10">
            <span className="text-sm text-gray-400">Rendering…</span>
          </div>
        )}

        <div className="overflow-auto max-h-[420px] flex justify-center p-2">
          <canvas ref={canvasRef} className="max-w-full rounded" />
        </div>

        {numPages > 0 && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10
                          bg-black/60 backdrop-blur-sm rounded-full px-3 py-1
                          flex items-center gap-1 text-xs text-white pointer-events-auto">
            <input
              type="number"
              className="w-9 bg-transparent text-center text-white font-mono
                         [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none
                         focus:outline-none"
              value={currentPage}
              min={1}
              max={numPages}
              onChange={e => {
                const v = parseInt(e.target.value);
                if (v >= 1 && v <= numPages) setCurrentPage(v);
              }}
            />
            <span className="text-white/50">/ {numPages}</span>
          </div>
        )}
      </div>

      {numPages > 1 && (
        <input
          type="range"
          min={1}
          max={numPages}
          value={currentPage}
          onChange={e => setCurrentPage(parseInt(e.target.value))}
          className="w-full h-0.5 accent-amber-500 cursor-pointer"
          style={{ margin: '2px 0' }}
        />
      )}

      <div className="pt-6">
      <button
        className="btn-primary w-full justify-center"
        disabled={!canCreate || submitting}
        onClick={onSubmit}
      >
        {submitting ? 'Creating…' : 'Create'}
      </button>
      </div>
    </div>
  );
}
