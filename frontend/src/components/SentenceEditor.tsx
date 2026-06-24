import { useEffect, useRef, useState } from 'react';
import { EditableSentence } from '../types';
import { onBookUpdate } from '../hooks/useWebSocket';
import { friendlyVoice } from '../lib/format';

interface Props {
  bookId: string;
  chapterIdx: number;
  voice: string;
}

const DOT: Record<EditableSentence['audioStatus'], string> = {
  complete: 'bg-green-500',
  generating: 'bg-amber-400 animate-pulse',
  stale: 'bg-amber-400',
  error: 'bg-red-500',
  pending: 'bg-gray-700',
};

export default function SentenceEditor({ bookId, chapterIdx, voice }: Props) {
  const [sentences, setSentences] = useState<EditableSentence[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'empty'>('loading');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);

  const loadSentences = () => {
    if (!voice) return () => {};
    let cancelled = false;
    setState('loading');
    setEditingId(null);
    setDeletingId(null);
    fetch(`/api/books/${bookId}/chapters/${chapterIdx}/sentences?voice=${encodeURIComponent(voice)}`)
      .then(r => (r.ok ? r.json() : { sentences: [] }))
      .then((data: { sentences?: EditableSentence[] }) => {
        if (cancelled) return;
        const list = Array.isArray(data.sentences) ? data.sentences : [];
        setSentences(list);
        setState(list.length ? 'ready' : 'empty');
      })
      .catch(() => { if (!cancelled) setState('empty'); });
    return () => { cancelled = true; };
  };

  useEffect(loadSentences, [bookId, chapterIdx, voice]);

  useEffect(() => {
    return onBookUpdate(data => {
      if (data.bookId !== bookId) return;

      const su = data.sentenceUpdate as { chapterIdx: number; sentenceId: string; text: string } | undefined;
      if (su && su.chapterIdx === chapterIdx) {
        setSentences(prev => prev.map(s => (s._id === su.sentenceId ? { ...s, text: su.text } : s)));
      }

      const sd = data.sentenceDeleted as { chapterIdx: number; sentenceId: string } | undefined;
      if (sd && sd.chapterIdx === chapterIdx) {
        setSentences(prev => prev
          .filter(s => s._id !== sd.sentenceId)
          .map((s, order) => ({ ...s, order })));
        setDeletingId(prev => (prev === sd.sentenceId ? null : prev));
      }

      const seg = data.segmentUpdate as
        | { chapterIdx: number; voice: string; sentenceId: string; audioStatus: EditableSentence['audioStatus']; audioError?: string }
        | undefined;
      if (seg && seg.chapterIdx === chapterIdx && seg.voice === voice) {
        setSentences(prev => prev.map(s =>
          s._id === seg.sentenceId ? { ...s, audioStatus: seg.audioStatus, audioError: seg.audioError } : s
        ));
      }
    });
  }, [bookId, chapterIdx, voice]);

  const startEdit = (s: EditableSentence) => {
    setEditingId(s._id);
    setDraft(s.text);
  };

  const saveEdit = async (s: EditableSentence) => {
    const text = draft.trim();
    setEditingId(null);
    if (!text || text === s.text) return;
    setSentences(prev => prev.map(x => (x._id === s._id ? { ...x, text, audioStatus: 'generating' } : x)));
    await fetch(`/api/books/${bookId}/chapters/${chapterIdx}/sentences/${s._id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
  };

  const deleteSentence = async (s: EditableSentence) => {
    if (sentences.length <= 1) return;
    if (!window.confirm('Delete this sentence and rebuild the chapter audio without it?')) return;
    setDeletingId(s._id);
    setSentences(prev => prev
      .filter(x => x._id !== s._id)
      .map((x, order) => ({ ...x, order })));
    const res = await fetch(`/api/books/${bookId}/chapters/${chapterIdx}/sentences/${s._id}`, { method: 'DELETE' })
      .catch(() => null);
    if (!res?.ok) loadSentences();
  };

  const regenerate = async (s: EditableSentence) => {
    setSentences(prev => prev.map(x => (x._id === s._id ? { ...x, audioStatus: 'generating' } : x)));
    await fetch(`/api/books/${bookId}/chapters/${chapterIdx}/sentences/${s._id}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice }),
    }).catch(() => {});
  };

  const preview = (s: EditableSentence) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (previewId === s._id && !audio.paused) {
      audio.pause();
      setPreviewId(null);
      return;
    }
    audio.src = `/api/books/${bookId}/chapters/${chapterIdx}/sentences/${s._id}/audio?voice=${encodeURIComponent(voice)}&_=${Date.now()}`;
    audio.play().then(() => setPreviewId(s._id)).catch(() => setPreviewId(null));
  };

  if (state === 'loading') {
    return <div className="card text-sm text-gray-500">Loading sentences...</div>;
  }

  if (state === 'empty') {
    return (
      <div className="card text-sm text-gray-500">
        Sentence editing is not available for this book. Regenerate a chapter to enable it.
      </div>
    );
  }

  return (
    <div className="card space-y-3">
      <audio ref={audioRef} onEnded={() => setPreviewId(null)} />

      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-gray-100">Edit sentences</h3>
        <span className="text-xs text-gray-500 shrink-0">{friendlyVoice(voice)} - {sentences.length} sentences</span>
      </div>
      <p className="text-xs text-gray-500">Fix one sentence or delete it; the chapter audio is rebuilt from sentence segments.</p>

      <div className="divide-y divide-gray-800/60 max-h-[28rem] overflow-y-auto -mx-2">
        {sentences.map(s => {
          const editing = editingId === s._id;
          const deleting = deletingId === s._id;
          return (
            <div key={s._id} className={`px-2 py-2 ${deleting ? 'opacity-50' : ''}`}>
              <div className="flex items-start gap-2">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 mt-2 ${DOT[s.audioStatus] ?? 'bg-gray-700'}`}
                  title={s.audioStatus}
                />
                <span className="text-gray-600 text-xs tabular-nums shrink-0 mt-1.5 w-6">{s.order + 1}.</span>

                {editing ? (
                  <div className="flex-1 space-y-2">
                    <textarea
                      className="input w-full text-sm leading-relaxed"
                      rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 60)))}
                      value={draft}
                      autoFocus
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit(s);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <button className="btn-primary text-xs py-1 px-3" onClick={() => saveEdit(s)}>Save &amp; re-render</button>
                      <button className="btn-secondary text-xs py-1 px-3" onClick={() => setEditingId(null)}>Cancel</button>
                      <span className="text-[11px] text-gray-600">Cmd+Enter to save - Esc to cancel</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      className="flex-1 text-left text-sm leading-relaxed text-gray-300 hover:text-amber-300 transition-colors disabled:cursor-not-allowed"
                      onClick={() => startEdit(s)}
                      disabled={deleting}
                      title="Click to edit"
                    >
                      {s.text}
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        className="p-1 text-gray-500 hover:text-amber-400 transition-colors disabled:opacity-30"
                        onClick={() => preview(s)}
                        disabled={s.audioStatus !== 'complete' || deleting}
                        title="Preview this sentence"
                        aria-label="Preview sentence"
                      >
                        {previewId === s._id
                          ? <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                          : <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>}
                      </button>
                      {s.audioStatus === 'error' && (
                        <button
                          className="p-1 text-gray-500 hover:text-amber-400 transition-colors"
                          onClick={() => regenerate(s)}
                          title="Retry"
                          aria-label="Retry sentence"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        </button>
                      )}
                      <button
                        className="p-1 text-gray-500 hover:text-red-400 transition-colors disabled:opacity-30"
                        onClick={() => deleteSentence(s)}
                        disabled={sentences.length <= 1 || deleting}
                        title="Delete this sentence"
                        aria-label="Delete sentence"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M6 7h12M9 7V5h6v2m-8 0l1 12h8l1-12" />
                        </svg>
                      </button>
                    </div>
                  </>
                )}
              </div>
              {s.audioStatus === 'error' && s.audioError && (
                <p className="text-[11px] text-red-400/90 pl-10 mt-1 break-words">{s.audioError}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
