import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { EditableSentence } from '../types';
import { useVoiceLabel } from '../hooks/useVoiceLabel';
import { t } from '../i18n';

// Full-page review of one chapter: every sentence with, per voice, its audio
// take and the whisper transcript of that take — so text, audio and what the
// machine actually heard sit together.
export default function SentenceReviewPage() {
  const { id, chapterIdx } = useParams<{ id: string; chapterIdx: string }>();
  const idx = parseInt(chapterIdx ?? '0', 10);
  const navigate = useNavigate();
  const book = useSelector((s: RootState) => s.books.books.find(b => b._id === id));
  const voices = book?.voices ?? [];
  const label = useVoiceLabel(voices);

  const [renderMode, setRenderMode] = useState<'now' | 'later'>('now');
  const [sentences, setSentences] = useState<EditableSentence[] | null>(null);
  const [perVoice, setPerVoice] = useState<Record<string, Record<string, EditableSentence>>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [addingAfter, setAddingAfter] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const load = () => {
    if (!id) return;
    fetch(`/api/books/${id}/chapters/${idx}/sentences`)
      .then(r => (r.ok ? r.json() : {}))
      .then((data: { sentences?: EditableSentence[] }) => {
        if (Array.isArray(data.sentences)) setSentences(data.sentences);
      })
      .catch(() => setSentences([]));
    voices.forEach(v => {
      fetch(`/api/books/${id}/chapters/${idx}/sentences?voice=${encodeURIComponent(v)}`)
        .then(r => (r.ok ? r.json() : {}))
        .then((data: { sentences?: EditableSentence[] }) => {
          if (!Array.isArray(data.sentences)) return;
          setPerVoice(prev => ({ ...prev, [v]: Object.fromEntries(data.sentences!.map(x => [x._id, x])) }));
        })
        .catch(() => {});
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [id, idx, voices.join(',')]);

  const call = async (method: string, path: string, body?: object) => {
    setBusy(true);
    try {
      await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      load();
    } finally {
      setBusy(false);
    }
  };

  const play = (sentenceId: string, voice: string) => {
    const key = `${sentenceId}|${voice}`;
    const audio = audioRef.current;
    if (!audio || !id) return;
    if (playing === key) { audio.pause(); return; }
    audio.src = `/api/books/${id}/chapters/${idx}/sentences/${sentenceId}/audio?voice=${encodeURIComponent(voice)}&_=${Date.now()}`;
    audio.play().then(() => setPlaying(key)).catch(() => setPlaying(null));
  };

  if (!book) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-gray-500">{t('Loading…')}</p></div>;
  }
  const chapter = book.chapters[idx];

  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur sticky top-0 z-10">
        <div className="w-[min(64rem,95vw)] mx-auto px-6 py-4 flex items-center gap-4">
          <button className="text-gray-500 hover:text-gray-300 transition-colors" onClick={() => navigate(`/books/${id}/edit`)}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-gray-100 truncate">
              {chapter?.title || t('Chapter {n}', { n: idx + 1 })}
            </h1>
            <p className="text-xs text-gray-500">{t('Review sentences · click text to edit · play each voice and read what Whisper heard')}</p>
          </div>
          <div className="flex items-center rounded-lg border border-gray-700 overflow-hidden text-xs shrink-0">
            <button
              className={`px-2.5 py-1.5 transition-colors ${renderMode === 'now' ? 'bg-amber-600/20 text-amber-300' : 'text-gray-400 hover:text-gray-200'}`}
              onClick={() => setRenderMode('now')}
              title={t('Edited sentences re-render immediately, ahead of everything else in the queue')}
            >
              {t('⚡ Re-render now')}
            </button>
            <button
              className={`px-2.5 py-1.5 border-l border-gray-700 transition-colors ${renderMode === 'later' ? 'bg-amber-600/20 text-amber-300' : 'text-gray-400 hover:text-gray-200'}`}
              onClick={() => setRenderMode('later')}
              title={t('Edits stack up and render together when you click Generate audio')}
            >
              {t('Stack for batch')}
            </button>
          </div>
        </div>
      </header>

      <main className="w-[min(64rem,95vw)] mx-auto px-6 py-6">
        <audio ref={audioRef} onEnded={() => setPlaying(null)} onPause={() => setPlaying(null)} />
        {sentences === null ? (
          <p className="text-sm text-gray-500">{t('Loading…')}</p>
        ) : sentences.length === 0 ? (
          <p className="text-sm text-gray-500">{t('No sentences in this chapter.')}</p>
        ) : (
          <div className="space-y-3">
            {sentences.map(s => (
              <div key={s._id} className="card !p-4 group">
                {editingId === s._id ? (
                  <div className="space-y-1.5">
                    <textarea autoFocus className="input w-full text-sm" rows={2} value={draft} onChange={e => setDraft(e.target.value)} />
                    <div className="flex gap-2">
                      <button
                        className="btn-primary text-xs"
                        disabled={busy || !draft.trim()}
                        onClick={async () => {
                          await call('PUT', `/api/books/${id}/chapters/${idx}/sentences/${s._id}`, { text: draft.trim(), render: renderMode });
                          setEditingId(null);
                        }}
                      >
                        {t('Save')}
                      </button>
                      <button className="btn-secondary text-xs" onClick={() => setEditingId(null)}>{t('Cancel')}</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <span className="text-gray-600 text-xs tabular-nums shrink-0 mt-0.5 w-8">{s.order + 1}.</span>
                    <button
                      className="flex-1 min-w-0 text-left text-sm text-gray-200 hover:text-white leading-relaxed"
                      onClick={() => { setEditingId(s._id); setDraft(s.text); }}
                      title={t('Click to edit')}
                    >
                      {s.text}
                    </button>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        className="text-gray-600 hover:text-amber-400 text-sm px-1"
                        onClick={() => { setAddingAfter(s._id); setAddDraft(''); }}
                        title={t('Add a sentence after this one')}
                      >
                        +
                      </button>
                      <button
                        className="text-gray-600 hover:text-red-400 px-1"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(t('Delete this sentence?'))) {
                            call('DELETE', `/api/books/${id}/chapters/${idx}/sentences/${s._id}`);
                          }
                        }}
                        title={t('Delete sentence')}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )}

                {addingAfter === s._id && (
                  <div className="mt-2 space-y-1.5 pl-11">
                    <textarea autoFocus className="input w-full text-sm" rows={2} placeholder={t('New sentence…')} value={addDraft} onChange={e => setAddDraft(e.target.value)} />
                    <div className="flex gap-2">
                      <button
                        className="btn-primary text-xs"
                        disabled={busy || !addDraft.trim()}
                        onClick={async () => {
                          await call('POST', `/api/books/${id}/chapters/${idx}/sentences/${s._id}/insert-after`, { text: addDraft.trim(), render: renderMode });
                          setAddingAfter(null);
                        }}
                      >
                        {t('Add')}
                      </button>
                      <button className="btn-secondary text-xs" onClick={() => setAddingAfter(null)}>{t('Cancel')}</button>
                    </div>
                  </div>
                )}

                {voices.length > 0 && (
                  <div className="mt-2 pl-11 space-y-1.5">
                    {voices.map(v => {
                      const pv = perVoice[v]?.[s._id];
                      const st = pv?.audioStatus;
                      const key = `${s._id}|${v}`;
                      const whisper = pv?.whisperResults?.length ? pv.whisperResults[pv.whisperResults.length - 1] : null;
                      return (
                        <div key={v} className={`rounded-lg border px-3 py-1.5 ${
                          pv?.needsReview ? 'border-amber-700/70 bg-amber-950/20' : 'border-gray-800 bg-gray-900/40'
                        }`}>
                          <div className="flex items-center gap-2">
                            {st === 'complete' ? (
                              <button
                                className={`shrink-0 transition-colors ${playing === key ? 'text-amber-400' : 'text-gray-500 hover:text-amber-300'}`}
                                onClick={() => play(s._id, v)}
                                title={t('Play this take')}
                              >
                                {playing === key ? (
                                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                                ) : (
                                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                                )}
                              </button>
                            ) : (
                              <span className={`w-2 h-2 rounded-full shrink-0 ${
                                st === 'generating' ? 'bg-amber-400 animate-pulse' : st === 'error' ? 'bg-red-500' : st === 'stale' ? 'bg-amber-500' : 'bg-gray-700'
                              }`} />
                            )}
                            <span className="text-xs text-gray-300 shrink-0">{label(v)}</span>
                            {st === 'stale' && <span className="text-[11px] text-amber-500">{t('re-render pending')}</span>}
                            {st === 'error' && <span className="text-[11px] text-red-400 truncate">{pv?.audioError || t('failed')}</span>}
                            {pv?.needsReview && <span className="text-[11px] text-amber-400">{t('mismatch')}</span>}
                          </div>
                          {whisper && (
                            <p className="text-[11px] text-gray-500 mt-0.5 pl-6">
                              {t('Whisper heard:')} <span className="text-gray-400 italic">{whisper}</span>
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
