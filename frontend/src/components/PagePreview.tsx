import { useState, useEffect, useRef } from 'react';
import { t } from '../i18n';

interface PagePreviewProps {
  bookId: string;
  totalPages: number;
  page: number;
  onPageChange: (page: number) => void;
  /** Lowest page the preview can navigate to (defaults to 1). */
  minPage?: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

export default function PagePreview({ bookId, totalPages, page, onPageChange, minPage = 1 }: PagePreviewProps) {
  const clamp = (p: number) => Math.min(totalPages, Math.max(minPage, p));

  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef     = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);

  const reset = () => { setScale(1); setTx(0); setTy(0); };
  const zoomBy = (factor: number) =>
    setScale(s => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s * factor));
      if (next === 1) { setTx(0); setTy(0); }
      return next;
    });

  // Non-passive wheel listener so we can preventDefault and zoom in place.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Drag to pan (only meaningful when zoomed in).
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setTx(d.tx + (e.clientX - d.x));
      setTy(d.ty + (e.clientY - d.y));
    };
    const up = () => setDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [dragging]);

  const startDrag = (e: React.MouseEvent) => {
    if (scale <= 1) return;
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty };
    setDragging(true);
  };

  return (
    <div className="flex flex-col gap-2 h-full w-full min-h-0">
      <div className="relative group bg-gray-800 rounded-xl overflow-hidden flex-1 min-h-0">
        <button
          className="absolute left-0 top-0 z-20 h-full w-10 flex items-center justify-center
                     opacity-0 group-hover:opacity-100 transition-opacity
                     bg-gradient-to-r from-black/50 to-transparent disabled:!opacity-0"
          onClick={() => onPageChange(clamp(page - 1))}
          disabled={page <= minPage}
        >
          <svg className="w-6 h-6 text-white drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <button
          className="absolute right-0 top-0 z-20 h-full w-10 flex items-center justify-center
                     opacity-0 group-hover:opacity-100 transition-opacity
                     bg-gradient-to-l from-black/50 to-transparent disabled:!opacity-0"
          onClick={() => onPageChange(clamp(page + 1))}
          disabled={page >= totalPages}
        >
          <svg className="w-6 h-6 text-white drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <div
          ref={viewportRef}
          className="absolute inset-0 flex items-center justify-center overflow-hidden select-none"
          style={{ cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default' }}
          onMouseDown={startDrag}
          onDoubleClick={() => (scale > 1 ? reset() : zoomBy(2))}
        >
          <img
            key={page}
            src={`/api/books/${bookId}/pages/${page}`}
            alt={t('Page {page}', { page })}
            draggable={false}
            className="max-w-full max-h-full object-contain rounded"
            style={{
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              transition: dragging ? 'none' : 'transform 90ms ease-out',
            }}
          />
        </div>

        {/* Zoom controls */}
        <div className="absolute top-2 right-2 z-20 flex flex-col gap-1">
          <button
            className="w-7 h-7 rounded bg-black/55 hover:bg-black/75 text-white flex items-center justify-center backdrop-blur-sm"
            onClick={() => zoomBy(1.3)}
            title={t('Zoom in')}
            aria-label={t('Zoom in')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            className="w-7 h-7 rounded bg-black/55 hover:bg-black/75 text-white flex items-center justify-center backdrop-blur-sm"
            onClick={() => zoomBy(1 / 1.3)}
            title={t('Zoom out')}
            aria-label={t('Zoom out')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14" />
            </svg>
          </button>
          <button
            className="w-7 h-7 rounded bg-black/55 hover:bg-black/75 text-white flex items-center justify-center backdrop-blur-sm disabled:opacity-40"
            onClick={reset}
            disabled={scale === 1 && tx === 0 && ty === 0}
            title={t('Reset zoom')}
            aria-label={t('Reset zoom')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        {totalPages > 0 && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10
                          bg-black/60 backdrop-blur-sm rounded-full px-3 py-1
                          flex items-center gap-1 text-xs text-white pointer-events-auto">
            <input
              type="number"
              className="w-9 bg-transparent text-center text-white font-mono
                         [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none
                         focus:outline-none"
              value={page}
              min={minPage}
              max={totalPages}
              onChange={e => {
                const v = parseInt(e.target.value);
                if (v >= minPage && v <= totalPages) onPageChange(v);
              }}
            />
            <span className="text-white/50">{t('/ {totalPages}', { totalPages })}</span>
          </div>
        )}
      </div>

      {totalPages > minPage && (
        <input
          type="range"
          min={minPage}
          max={totalPages}
          value={page}
          onChange={e => onPageChange(parseInt(e.target.value))}
          className="w-full h-0.5 accent-amber-500 cursor-pointer shrink-0"
        />
      )}
    </div>
  );
}
