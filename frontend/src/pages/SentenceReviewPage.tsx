import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { EditableSentence } from '../types';
import { useVoiceLabel, useVoiceNames } from '../hooks/useVoiceLabel';
import PagePreview from '../components/PagePreview';
import { t } from '../i18n';

const ALL_VOICES = '*';

const dotClass = (st?: string) =>
  st === 'complete' ? 'bg-emerald-500'
  : st === 'generating' ? 'bg-amber-400 animate-pulse'
  : st === 'error' ? 'bg-red-500'
  : st === 'stale' ? 'bg-amber-500'
  : 'bg-gray-700';

// Full-page review of one chapter, chat-style: sentences in a left rail, the
// selected one edited on the right next to its per-voice takes (with what
// Whisper heard) and the source page it came from. Re-renders touch only the
// sentence's segment — the chapter mp3 is reassembled once, on Save.
export default function SentenceReviewPage() {
  const { id, chapterIdx } = useParams<{ id: string; chapterIdx: string }>();
  const idx = parseInt(chapterIdx ?? '0', 10);
  const navigate = useNavigate();
  const book = useSelector((s: RootState) => s.books.books.find(b => b._id === id));
  const voices = useMemo(() => book?.voices ?? [], [book?.voices]);
  const label = useVoiceLabel(voices);
  const voiceNames = useVoiceNames();
  const voiceOptions = useMemo(
    () => Object.entries(voiceNames)
      .map(([engine, byId]) => ({
        engine,
        voices: Object.entries(byId)
          .map(([bare, name]) => ({ value: `${engine}:${bare}`, name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.engine.localeCompare(b.engine)),
    [voiceNames],
  );

  const [sentences, setSentences] = useState<EditableSentence[] | null>(null);
  const [perVoice, setPerVoice] = useState<Record<string, Record<string, EditableSentence>>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addDraft, setAddDraft] = useState('');
  const [addPosition, setAddPosition] = useState<'after' | 'before'>('after');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingMerge, setPendingMerge] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [previewPage, setPreviewPage] = useState(0);
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

  const rendering = Object.values(perVoice).some(byId =>
    Object.values(byId).some(s => s.audioStatus === 'generating'));
  useEffect(() => {
    if (!rendering) return;
    const timer = window.setInterval(load, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendering, id, idx, voices.join(',')]);

  const selected = sentences?.find(s => s._id === selectedId) ?? sentences?.[0] ?? null;
  const selectedKey = selected?._id;
  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected._id);
    setDraft(selected.text);
    setDirty(false);
    const page = selected.page || book?.chapters[idx]?.startPage || 0;
    if (page > 0) setPreviewPage(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

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

  const applyText = async () => {
    if (!selected || !dirty || !draft.trim()) return;
    await call('PUT', `/api/books/${id}/chapters/${idx}/sentences/${selected._id}`,
      { text: draft.trim(), render: 'later' });
    setDirty(false);
  };

  const rerenderVoice = async (voice: string) => {
    if (!selected) return;
    await applyText();
    setPendingMerge(true);
    await call('POST', `/api/books/${id}/chapters/${idx}/sentences/${selected._id}/regenerate`,
      { voice, merge: false });
  };

  // Pin the voice that speaks this one sentence — for `voice`, or for every
  // voice when it is ALL_VOICES (a quote read by someone else) — then re-render
  // the takes it affects so the change is audible right away.
  const setOverride = async (voice: string, synthVoice: string) => {
    if (!selected) return;
    await applyText();
    await call('PUT', `/api/books/${id}/chapters/${idx}/sentences/${selected._id}/voice-override`,
      { voice, synthVoice });
    setPendingMerge(true);
    for (const v of voice === ALL_VOICES ? voices : [voice]) {
      await call('POST', `/api/books/${id}/chapters/${idx}/sentences/${selected._id}/regenerate`,
        { voice: v, merge: false });
    }
  };

  const overrideSelect = (voice: string) => (
    <select
      className="input text-[11px] py-1 px-1.5 max-w-[11rem]"
      value={selected?.voiceOverrides?.[voice] ?? ''}
      disabled={busy}
      onChange={e => setOverride(voice, e.target.value)}
      title={t('Read this sentence with a different voice')}
    >
      <option value="">{voice === ALL_VOICES ? t('Each voice as usual') : t('Same voice')}</option>
      {voiceOptions.map(g => (
        <optgroup key={g.engine} label={g.engine}>
          {g.voices.map(o => <option key={o.value} value={o.value}>{o.name}</option>)}
        </optgroup>
      ))}
    </select>
  );

  const save = async () => {
    setSaving(true);
    try {
      await applyText();
      await fetch(`/api/books/${id}/chapters/${idx}/finalize`, { method: 'POST' });
      setPendingMerge(false);
      navigate(`/books/${id}/edit`);
    } finally {
      setSaving(false);
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

  const worstStatus = (sentenceId: string) => {
    const states = voices.map(v => perVoice[v]?.[sentenceId]?.audioStatus);
    if (states.some(s => s === 'error')) return 'error';
    if (states.some(s => s === 'generating')) return 'generating';
    if (states.some(s => s !== 'complete')) return 'stale';
    return 'complete';
  };
  const hasMismatch = (sentenceId: string) => voices.some(v => perVoice[v]?.[sentenceId]?.needsReview);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur sticky top-0 z-10">
        <div className="px-6 py-4 flex items-center gap-4">
          <button className="text-gray-500 hover:text-gray-300 transition-colors" onClick={() => navigate(`/books/${id}/edit`)}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-gray-100 truncate">
              {chapter?.title || t('Chapter {n}', { n: idx + 1 })}
            </h1>
            <p className="text-xs text-gray-500">
              {t('Pick a sentence · edit its text · re-render a single voice · save to reassemble the chapter')}
            </p>
          </div>
          {pendingMerge && (
            <span className="text-[11px] text-amber-400 shrink-0 hidden sm:inline">
              {t('Chapter audio not reassembled yet')}
            </span>
          )}
          <button className="btn-primary text-sm shrink-0" disabled={saving || busy} onClick={save}>
            {saving ? t('Saving…') : t('Save')}
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <audio ref={audioRef} onEnded={() => setPlaying(null)} onPause={() => setPlaying(null)} />

        <aside className="w-72 shrink-0 border-r border-gray-800 flex flex-col h-[calc(100vh-73px)] sticky top-[73px]">
          <div className="p-3 border-b border-gray-800">
            <button
              className="btn-secondary text-xs w-full justify-center"
              disabled={!selected}
              onClick={() => { setAddDraft(''); setAddPosition('after'); setShowAdd(true); }}
            >
              {t('+ Add sentence')}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sentences === null ? (
              <p className="text-xs text-gray-500 p-2">{t('Loading…')}</p>
            ) : sentences.length === 0 ? (
              <p className="text-xs text-gray-500 p-2">{t('No sentences in this chapter.')}</p>
            ) : sentences.map(s => (
              <button
                key={s._id}
                onClick={() => setSelectedId(s._id)}
                className={`w-full text-left rounded-lg px-2.5 py-2 text-xs leading-snug transition-colors flex gap-2 ${
                  s._id === selected?._id ? 'bg-amber-600/15 text-gray-100' : 'text-gray-400 hover:bg-gray-800/60'
                }`}
              >
                <span className="flex flex-col items-center gap-1 shrink-0 pt-0.5">
                  <span className="tabular-nums text-gray-600">{s.order + 1}</span>
                  <span className={`w-1.5 h-1.5 rounded-full ${dotClass(worstStatus(s._id))}`} />
                </span>
                <span className="min-w-0 flex-1 line-clamp-3">{s.text}</span>
                {hasMismatch(s._id) && <span className="text-amber-400 shrink-0">!</span>}
              </button>
            ))}
          </div>
        </aside>

        <main className="flex-1 min-w-0 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_22rem] gap-5 p-6 items-start">
          {!selected ? (
            <p className="text-sm text-gray-500">{t('Select a sentence to edit.')}</p>
          ) : (
            <div className="space-y-5 min-w-0">
              <div className="card space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-gray-200">
                    {t('Sentence {n}', { n: selected.order + 1 })}
                    {selected.page ? <span className="text-xs font-normal text-gray-500"> · {t('page {n}', { n: selected.page })}</span> : null}
                  </h2>
                  <button
                    className="text-gray-600 hover:text-red-400"
                    disabled={busy || (sentences?.length ?? 0) <= 1}
                    title={t('Delete sentence')}
                    onClick={() => {
                      if (!confirm(t('Delete this sentence?'))) return;
                      setPendingMerge(true);
                      setSelectedId(null);
                      call('DELETE', `/api/books/${id}/chapters/${idx}/sentences/${selected._id}`);
                    }}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <textarea
                  className="input w-full text-sm"
                  rows={4}
                  value={draft}
                  onChange={e => { setDraft(e.target.value); setDirty(true); }}
                  onBlur={applyText}
                />
                {dirty && <p className="text-[11px] text-amber-400">{t('Unsaved text — re-render a voice or save to apply.')}</p>}
                <div className="flex items-center gap-2 flex-wrap pt-1">
                  <span className="text-[11px] text-gray-500">{t('Read by:')}</span>
                  {overrideSelect(ALL_VOICES)}
                  {selected.voiceOverrides?.[ALL_VOICES] && (
                    <span className="text-[11px] text-amber-400">{t('every voice overridden')}</span>
                  )}
                </div>
              </div>

              <div className="card space-y-2">
                <h3 className="text-sm font-semibold text-gray-200">{t('Voices')}</h3>
                {voices.length === 0 && <p className="text-xs text-gray-500">{t('No voices yet.')}</p>}
                {voices.map(v => {
                  const pv = perVoice[v]?.[selected._id];
                  const st = pv?.audioStatus;
                  const key = `${selected._id}|${v}`;
                  const whisper = pv?.whisperResults?.length ? pv.whisperResults[pv.whisperResults.length - 1] : null;
                  return (
                    <div key={v} className={`rounded-lg border px-3 py-2 ${
                      pv?.needsReview ? 'border-amber-700/70 bg-amber-950/20' : 'border-gray-800 bg-gray-900/40'
                    }`}>
                      <div className="flex items-center gap-2">
                        {st === 'complete' ? (
                          <button
                            className={`shrink-0 transition-colors ${playing === key ? 'text-amber-400' : 'text-gray-500 hover:text-amber-300'}`}
                            onClick={() => play(selected._id, v)}
                            title={t('Play this take')}
                          >
                            {playing === key ? (
                              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                            ) : (
                              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                            )}
                          </button>
                        ) : (
                          <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass(st)}`} />
                        )}
                        <span className="text-xs text-gray-300 shrink-0">{label(v)}</span>
                        {st === 'stale' && <span className="text-[11px] text-amber-500">{t('re-render pending')}</span>}
                        {st === 'error' && <span className="text-[11px] text-red-400 truncate">{pv?.audioError || t('failed')}</span>}
                        {pv?.needsReview && <span className="text-[11px] text-amber-400">{t('mismatch')}</span>}
                        <button
                          className="btn-secondary text-[11px] ml-auto shrink-0"
                          disabled={busy || st === 'generating'}
                          onClick={() => rerenderVoice(v)}
                          title={t('Render this sentence again for this voice only')}
                        >
                          {st === 'generating' ? t('Rendering…') : t('Re-render')}
                        </button>
                      </div>
                      <div className="flex items-center gap-2 mt-1 pl-6 flex-wrap">
                        {overrideSelect(v)}
                        {pv?.synthVoice && !selected.voiceOverrides?.[v] && (
                          <span className="text-[11px] text-gray-500">{t('via {voice}', { voice: label(pv.synthVoice) })}</span>
                        )}
                      </div>
                      {whisper && (
                        <p className="text-[11px] text-gray-500 mt-1 pl-6">
                          {t('Whisper heard:')} <span className="text-gray-400 italic">{whisper}</span>
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="card h-[calc(100vh-8rem)] flex flex-col xl:sticky xl:top-24">
            <h3 className="text-sm font-semibold text-gray-200 mb-2 shrink-0">{t('Page preview')}</h3>
            {previewPage > 0 && book.totalPages > 0 ? (
              <PagePreview
                bookId={book._id}
                totalPages={book.totalPages}
                page={previewPage}
                onPageChange={setPreviewPage}
              />
            ) : (
              <p className="text-xs text-gray-500">{t('No page for this sentence.')}</p>
            )}
          </div>
        </main>
      </div>

      {showAdd && selected && (
        <div className="fixed inset-0 z-20 bg-black/60 flex items-center justify-center p-6" onClick={() => setShowAdd(false)}>
          <div className="card w-[min(32rem,95vw)] space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-100">{t('Add sentence')}</h3>
            <textarea
              autoFocus
              className="input w-full text-sm"
              rows={3}
              placeholder={t('New sentence…')}
              value={addDraft}
              onChange={e => setAddDraft(e.target.value)}
            />
            <div className="flex items-center gap-2 text-xs">
              {(['before', 'after'] as const).map(pos => (
                <button
                  key={pos}
                  className={`px-2.5 py-1.5 rounded-lg border transition-colors ${
                    addPosition === pos ? 'border-amber-600 bg-amber-600/15 text-amber-300' : 'border-gray-700 text-gray-400 hover:text-gray-200'
                  }`}
                  onClick={() => setAddPosition(pos)}
                >
                  {pos === 'before' ? t('Before selected sentence') : t('After selected sentence')}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-500 line-clamp-2">{selected.text}</p>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary text-xs" onClick={() => setShowAdd(false)}>{t('Cancel')}</button>
              <button
                className="btn-primary text-xs"
                disabled={busy || !addDraft.trim()}
                onClick={async () => {
                  setPendingMerge(true);
                  await call('POST', `/api/books/${id}/chapters/${idx}/sentences/${selected._id}/insert-after`,
                    { text: addDraft.trim(), position: addPosition, render: 'later' });
                  setShowAdd(false);
                }}
              >
                {t('Add')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
