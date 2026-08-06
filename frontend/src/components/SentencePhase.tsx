import { useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../store';
import { backToChapterReview, addVoice, removeVoice, generateBook } from '../store/booksSlice';
import { Book, EditableSentence, TtsModel } from '../types';
import { friendlyVoice, engineOf } from '../lib/format';
import { useVoiceLabel } from '../hooks/useVoiceLabel';
import { t } from '../i18n';

// ---------------------------------------------------------------------------
// Sentence review: every chapter's TTS-ready sentences, editable before any
// audio is rendered.
// ---------------------------------------------------------------------------

function ChapterSentences({ bookId, chapterIdx }: { bookId: string; chapterIdx: number }) {
  const [sentences, setSentences] = useState<EditableSentence[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [addingAfter, setAddingAfter] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch(`/api/books/${bookId}/chapters/${chapterIdx}/sentences`)
      .then(r => (r.ok ? r.json() : []))
      .then((data: unknown) => { if (Array.isArray(data)) setSentences(data as EditableSentence[]); })
      .catch(() => setSentences([]));
  };
  useEffect(load, [bookId, chapterIdx]);

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

  if (sentences === null) return <p className="text-xs text-gray-500 px-3 py-2">{t('Loading…')}</p>;
  if (sentences.length === 0) return <p className="text-xs text-gray-500 px-3 py-2">{t('No sentences in this chapter.')}</p>;

  return (
    <div className="divide-y divide-gray-800/60">
      {sentences.map(s => (
        <div key={s._id} className="px-3 py-1.5 group">
          {editingId === s._id ? (
            <div className="space-y-1.5">
              <textarea
                autoFocus
                className="input w-full text-sm"
                rows={2}
                value={draft}
                onChange={e => setDraft(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  className="btn-primary text-xs"
                  disabled={busy || !draft.trim()}
                  onClick={async () => {
                    await call('PUT', `/api/books/${bookId}/chapters/${chapterIdx}/sentences/${s._id}`, { text: draft.trim() });
                    setEditingId(null);
                  }}
                >
                  {t('Save')}
                </button>
                <button className="btn-secondary text-xs" onClick={() => setEditingId(null)}>{t('Cancel')}</button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <button
                className="flex-1 text-left text-sm text-gray-300 hover:text-gray-100 leading-snug"
                onClick={() => { setEditingId(s._id); setDraft(s.text); }}
                title={t('Click to edit')}
              >
                {s.text}
              </button>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button
                  className="text-gray-600 hover:text-amber-400 text-xs px-1"
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
                      call('DELETE', `/api/books/${bookId}/chapters/${chapterIdx}/sentences/${s._id}`);
                    }
                  }}
                  title={t('Delete sentence')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          )}
          {addingAfter === s._id && (
            <div className="mt-1.5 space-y-1.5">
              <textarea
                autoFocus
                className="input w-full text-sm"
                rows={2}
                placeholder={t('New sentence…')}
                value={addDraft}
                onChange={e => setAddDraft(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  className="btn-primary text-xs"
                  disabled={busy || !addDraft.trim()}
                  onClick={async () => {
                    await call('POST', `/api/books/${bookId}/chapters/${chapterIdx}/sentences/${s._id}/insert-after`, { text: addDraft.trim() });
                    setAddingAfter(null);
                  }}
                >
                  {t('Add')}
                </button>
                <button className="btn-secondary text-xs" onClick={() => setAddingAfter(null)}>{t('Cancel')}</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function SentenceReviewSection({ book }: { book: Book }) {
  const dispatch = useDispatch<AppDispatch>();
  const [open, setOpen] = useState<number | null>(0);
  const [goingBack, setGoingBack] = useState(false);

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-100">{t('Review sentences')}</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            {t('These are the exact sentences the voices will read. Click one to edit it before generating audio.')}
          </p>
        </div>
        <button
          className="btn-secondary text-xs shrink-0"
          disabled={goingBack}
          onClick={async () => {
            setGoingBack(true);
            try { await dispatch(backToChapterReview(book._id)).unwrap(); }
            catch (e) { alert(e instanceof Error ? e.message : String(e)); }
            finally { setGoingBack(false); }
          }}
        >
          {t('← Back to chapters & text')}
        </button>
      </div>

      <div className="rounded-lg border border-gray-700 divide-y divide-gray-800/70">
        {book.chapters.map((c, i) => (
          <div key={c._id}>
            <button
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-800/50 transition-colors"
              onClick={() => setOpen(open === i ? null : i)}
            >
              <span className="text-gray-500 text-xs tabular-nums shrink-0 w-5">{i + 1}.</span>
              <span className="text-sm text-gray-200 truncate flex-1">{c.title || t('Chapter {n}', { n: i + 1 })}</span>
              <svg
                className={`w-4 h-4 text-gray-600 shrink-0 transition-transform ${open === i ? 'rotate-90' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
            {open === i && (
              <div className="border-t border-gray-800 max-h-80 overflow-y-auto bg-gray-900/40">
                <ChapterSentences bookId={book._id} chapterIdx={i} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice section: pick the readers inline (no popup), listen to each one from
// the book's own text, and either apply changes on the fly or stack them and
// generate everything at once.
// ---------------------------------------------------------------------------

const VOICE_LANGS = [
  { id: 'pt', label: t('Portuguese') },
  { id: 'en', label: t('English') },
];

function langOfVoice(model: string, v: string): string {
  if (model === 'kokoro') return v.startsWith('pf') || v.startsWith('pm') ? 'pt' : 'en';
  return v.startsWith('pt-') ? 'pt' : 'en';
}

export function VoiceSection({ book }: { book: Book }) {
  const dispatch = useDispatch<AppDispatch>();
  const label = useVoiceLabel(book.voices);

  const [models, setModels] = useState<TtsModel[]>([]);
  const [model, setModel] = useState('chatterbox');
  const [allVoices, setAllVoices] = useState<string[]>([]);
  const [voiceNames, setVoiceNames] = useState<Record<string, string>>({});
  const [voicesState, setVoicesState] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [lang, setLang] = useState('pt');
  const [staged, setStaged] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // One shared sample player: /api/books/{id}/sample?voice=… synthesizes a
  // short excerpt of this book with that voice.
  const [preview, setPreview] = useState('');
  const [sampleState, setSampleState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const urlRef = useRef<string | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then((m: unknown) => { if (Array.isArray(m) && m.length) { setModels(m as TtsModel[]); setModel((m as TtsModel[])[0].id); } })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAllVoices([]); setVoiceNames({}); setVoicesState('loading');
    fetch(`/api/models/${model}/voices`)
      .then(r => (r.ok ? r.json() : { available: false, voices: [] }))
      .then((data: { available?: boolean; voices?: string[]; names?: Record<string, string> }) => {
        if (cancelled) return;
        if (data.available === false) { setVoicesState('offline'); return; }
        const list = Array.isArray(data.voices) ? data.voices : [];
        setAllVoices(list);
        setVoiceNames(data.names && typeof data.names === 'object' ? data.names : {});
        setVoicesState('ready');
        if (!list.some(x => langOfVoice(model, x) === lang)) {
          const first = list.find(Boolean);
          if (first) setLang(langOfVoice(model, first));
        }
      })
      .catch(() => { if (!cancelled) setVoicesState('offline'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const loadSample = async (composite: string) => {
    setPreview(composite);
    setSampleState('loading');
    setPlaying(false);
    const reqId = ++reqIdRef.current;
    try {
      const res = await fetch(`/api/books/${book._id}/sample?voice=${encodeURIComponent(composite)}`);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (reqId !== reqIdRef.current) return;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(blob);
      setSampleState('ready');
      const audio = audioRef.current;
      if (audio) { audio.src = urlRef.current; audio.play().catch(() => {}); }
    } catch {
      if (reqId === reqIdRef.current) setSampleState('error');
    }
  };

  const PlayButton = ({ composite }: { composite: string }) => {
    const active = preview === composite;
    return (
      <button
        className={`shrink-0 transition-colors ${active && playing ? 'text-amber-400' : 'text-gray-500 hover:text-amber-300'}`}
        onClick={() => {
          const audio = audioRef.current;
          if (active && audio && sampleState === 'ready') {
            if (playing) audio.pause(); else audio.play().catch(() => {});
          } else {
            loadSample(composite);
          }
        }}
        title={t('Hear this voice reading this book')}
      >
        {active && sampleState === 'loading' ? (
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        ) : active && playing ? (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
        ) : (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        )}
      </button>
    );
  };

  const filtered = allVoices.filter(v =>
    langOfVoice(model, v) === lang &&
    !book.voices.includes(`${model}:${v}`) &&
    !staged.includes(`${model}:${v}`));

  const applyStaged = async () => {
    if (staged.length) await dispatch(addVoice({ bookId: book._id, voice: staged })).unwrap();
    setStaged([]);
  };

  const generateAll = async () => {
    setBusy(true);
    try {
      await applyStaged();
      await dispatch(generateBook(book._id)).unwrap();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hasVoices = book.voices.length > 0 || staged.length > 0;

  return (
    <div className="card space-y-4">
      <div>
        <h3 className="font-semibold text-gray-100">{t('Voices')}</h3>
        <p className="text-sm text-gray-500 mt-0.5">
          {t('Choose who reads the book. Press play to hear each voice reading an excerpt of this book.')}
        </p>
      </div>

      {book.voices.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-wide text-gray-500">{t('Current voices')}</p>
          {book.voices.map(v => (
            <div key={v} className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/40 px-3 py-1.5">
              <PlayButton composite={v} />
              <span className="text-sm text-gray-200 flex-1 truncate">{label(v)}</span>
              <button
                className="text-gray-600 hover:text-red-400 shrink-0"
                onClick={() => {
                  if (confirm(t('Remove voice "{v}" and its audio?', { v: label(v) }))) {
                    dispatch(removeVoice({ bookId: book._id, voice: v })).unwrap().catch(e => alert(e.message));
                  }
                }}
                title={t('Remove this voice now')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {staged.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-wide text-gray-500">{t('To add ({n})', { n: staged.length })}</p>
          {staged.map(v => (
            <div key={v} className="flex items-center gap-2 rounded-lg border border-amber-600/50 bg-amber-950/20 px-3 py-1.5">
              <PlayButton composite={v} />
              <span className="text-sm text-amber-200 flex-1 truncate">{friendlyVoice(v)} <span className="text-amber-500/70">· {engineOf(v)}</span></span>
              <button
                className="text-xs text-amber-400 hover:text-amber-300 shrink-0"
                onClick={() => dispatch(addVoice({ bookId: book._id, voice: v })).unwrap()
                  .then(() => setStaged(prev => prev.filter(x => x !== v)))
                  .catch(e => alert(e.message))}
                title={t('Add this voice right away')}
              >
                {t('Apply now')}
              </button>
              <button
                className="text-amber-500/60 hover:text-red-400 shrink-0"
                onClick={() => setStaged(prev => prev.filter(x => x !== v))}
                title={t('Remove from the list')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {models.map(m => (
            <button
              key={m.id}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                m.id === model
                  ? 'bg-amber-600/20 text-amber-400 ring-1 ring-amber-500'
                  : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
              }`}
              onClick={() => setModel(m.id)}
            >
              {m.label}
            </button>
          ))}
          {voicesState !== 'offline' && (
            <select className="input w-auto text-sm py-1.5" value={lang} onChange={e => setLang(e.target.value)}>
              {VOICE_LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          )}
        </div>

        {voicesState === 'offline' ? (
          <p className="text-sm text-amber-300">{t('This model is offline right now — pick another one.')}</p>
        ) : voicesState === 'loading' ? (
          <p className="text-sm text-gray-500">{t('Checking model…')}</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-gray-500">{t('No more voices for this model and language.')}</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {filtered.map(v => {
              const composite = `${model}:${v}`;
              return (
                <div key={v} className="flex items-center gap-2 rounded-lg bg-gray-800 hover:bg-gray-700 px-2.5 py-1.5 transition-colors">
                  <PlayButton composite={composite} />
                  <button
                    className="text-sm text-gray-200 flex-1 text-left truncate"
                    onClick={() => setStaged(prev => [...prev, composite])}
                    title={t('Add to the list')}
                  >
                    {voiceNames[v] ?? friendlyVoice(v)}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <audio
        ref={audioRef}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />

      <div className="flex items-center justify-end gap-2 pt-1 border-t border-gray-800">
        {staged.length > 0 && (
          <button className="btn-secondary text-sm" disabled={busy} onClick={() => applyStaged().catch(e => alert(e.message))}>
            {t('Apply {n} without generating', { n: staged.length })}
          </button>
        )}
        <button className="btn-primary text-sm disabled:opacity-40" disabled={busy || !hasVoices} onClick={generateAll}>
          {staged.length > 0 ? t('Add {n} and generate audio', { n: staged.length }) : t('Generate audio')}
        </button>
      </div>
    </div>
  );
}
