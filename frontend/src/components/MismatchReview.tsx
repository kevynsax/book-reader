import { useEffect, useRef, useState } from 'react';
import { onBookUpdate } from '../hooks/useWebSocket';
import { friendlyVoice } from '../lib/format';
import { TtsModel } from '../types';
import { t } from '../i18n';

interface MismatchVoice {
  voice: string;
  whisperResults?: string[];
}

interface Mismatch {
  chapterIdx: number;
  chapterTitle: string;
  sentenceId: string;
  order: number;
  text: string;
  voices: MismatchVoice[];
}

interface Props {
  bookId: string;
}

// Lists every sentence whose audio kept disagreeing with Whisper so the user
// can fix it: edit the text, add a follow-up sentence beside it, or re-render
// in place — optionally with another model.
export default function MismatchReview({ bookId }: Props) {
  const [mismatches, setMismatches] = useState<Mismatch[]>([]);
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);

  const [models, setModels] = useState<TtsModel[]>([]);
  const [overrideModel, setOverrideModel] = useState('');
  const [overrideVoices, setOverrideVoices] = useState<string[]>([]);
  const [overrideVoice, setOverrideVoice] = useState('');

  const audioRef = useRef<HTMLAudioElement>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>();

  const load = () => {
    fetch(`/api/books/${bookId}/mismatches`)
      .then(r => (r.ok ? r.json() : { mismatches: [] }))
      .then((data: { mismatches?: Mismatch[] }) => {
        const list = Array.isArray(data.mismatches) ? data.mismatches : [];
        setMismatches(list);
        setBusyId(null);
      })
      .catch(() => {});
  };

  useEffect(load, [bookId]);

  useEffect(() => {
    return onBookUpdate(data => {
      if (data.bookId !== bookId) return;
      const seg = data.segmentUpdate as { audioStatus?: string } | undefined;
      if (!seg || (seg.audioStatus !== 'complete' && seg.audioStatus !== 'error')) return;
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(load, 1200);
    });
  }, [bookId]);

  useEffect(() => () => clearTimeout(reloadTimer.current), []);

  useEffect(() => {
    if (!open || models.length) return;
    fetch('/api/models')
      .then(r => r.json())
      .then((m: unknown) => { if (Array.isArray(m) && m.length) setModels(m as TtsModel[]); })
      .catch(() => {});
  }, [open, models.length]);

  useEffect(() => {
    setOverrideVoice('');
    setOverrideVoices([]);
    if (!overrideModel) return;
    let cancelled = false;
    fetch(`/api/models/${overrideModel}/voices`)
      .then(r => (r.ok ? r.json() : { voices: [] }))
      .then((data: { voices?: string[] }) => {
        if (cancelled) return;
        const list = Array.isArray(data.voices) ? data.voices : [];
        setOverrideVoices(list);
        if (list.length) setOverrideVoice(list[0]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [overrideModel]);

  if (!mismatches.length) return null;

  const expand = (m: Mismatch) => {
    const next = expandedId === m.sentenceId ? null : m.sentenceId;
    setExpandedId(next);
    setEditing(false);
    setAdding(false);
    setDraft(m.text);
    setAddDraft('');
    setOverrideModel('');
  };

  const saveEdit = async (m: Mismatch) => {
    const text = draft.trim();
    setEditing(false);
    if (!text || text === m.text) return;
    setBusyId(m.sentenceId);
    await fetch(`/api/books/${bookId}/chapters/${m.chapterIdx}/sentences/${m.sentenceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
  };

  const addAfter = async (m: Mismatch) => {
    const text = addDraft.trim();
    if (!text) return;
    setAdding(false);
    setAddDraft('');
    setBusyId(m.sentenceId);
    await fetch(`/api/books/${bookId}/chapters/${m.chapterIdx}/sentences/${m.sentenceId}/insert-after`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
  };

  const regenerate = async (m: Mismatch) => {
    const synthVoice = overrideModel && overrideVoice ? `${overrideModel}:${overrideVoice}` : '';
    setBusyId(m.sentenceId);
    for (const v of m.voices) {
      await fetch(`/api/books/${bookId}/chapters/${m.chapterIdx}/sentences/${m.sentenceId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: v.voice, synthVoice }),
      }).catch(() => {});
    }
  };

  const preview = (m: Mismatch, voice: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    const key = `${m.sentenceId}|${voice}`;
    if (previewKey === key && !audio.paused) {
      audio.pause();
      setPreviewKey(null);
      return;
    }
    audio.src = `/api/books/${bookId}/chapters/${m.chapterIdx}/sentences/${m.sentenceId}/audio?voice=${encodeURIComponent(voice)}&_=${Date.now()}`;
    audio.play().then(() => setPreviewKey(key)).catch(() => setPreviewKey(null));
  };

  return (
    <div className="card space-y-3 border border-amber-800/50">
      <audio ref={audioRef} onEnded={() => setPreviewKey(null)} />

      <button className="w-full flex items-center justify-between gap-3" onClick={() => setOpen(v => !v)}>
        <span className="flex items-center gap-2 font-semibold text-amber-300">
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          {t('Review sentences ({n})', { n: mismatches.length })}
        </span>
        <span className="text-xs text-gray-500 shrink-0">{open ? t('Hide') : t('Show')}</span>
      </button>

      {open && (
        <>
          <p className="text-xs text-gray-500">
            {t('The audio for these sentences kept disagreeing with what Whisper heard. Edit the text, add a sentence beside it, or re-render — optionally with another model.')}
          </p>

          <div className="divide-y divide-gray-800/60 max-h-[28rem] overflow-y-auto -mx-2">
            {mismatches.map(m => {
              const expanded = expandedId === m.sentenceId;
              const busy = busyId === m.sentenceId;
              return (
                <div key={`${m.chapterIdx}|${m.sentenceId}`} className={`px-2 py-2 ${busy ? 'opacity-50' : ''}`}>
                  <button className="w-full text-left" onClick={() => expand(m)}>
                    <p className="text-[11px] text-gray-500 truncate">
                      {m.chapterTitle} · {t('sentence {n}', { n: m.order + 1 })}
                    </p>
                    <p className="text-sm leading-relaxed text-gray-300">{m.text}</p>
                  </button>

                  {expanded && (
                    <div className="mt-2 pl-2 border-l border-gray-800 space-y-3">
                      {m.voices.map(v => (
                        <div key={v.voice} className="text-xs space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <button
                              className="p-0.5 text-gray-500 hover:text-amber-400 transition-colors"
                              onClick={() => preview(m, v.voice)}
                              title={t('Preview this sentence')}
                              aria-label={t('Preview sentence')}
                            >
                              {previewKey === `${m.sentenceId}|${v.voice}`
                                ? <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                                : <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>}
                            </button>
                            <span className="text-gray-400 font-medium">{friendlyVoice(v.voice)}</span>
                          </div>
                          {(v.whisperResults ?? []).map((w, i) => (
                            <p key={i} className="text-gray-500 pl-5">
                              <span className="text-gray-600">{t('heard')}:</span> {w}
                            </p>
                          ))}
                        </div>
                      ))}

                      {editing ? (
                        <div className="space-y-2">
                          <textarea
                            className="input w-full text-sm leading-relaxed"
                            rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 60)))}
                            value={draft}
                            autoFocus
                            onChange={e => setDraft(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit(m);
                              if (e.key === 'Escape') setEditing(false);
                            }}
                          />
                          <div className="flex items-center gap-2">
                            <button className="btn-primary text-xs py-1 px-3" onClick={() => saveEdit(m)}>{t('Save & re-render')}</button>
                            <button className="btn-secondary text-xs py-1 px-3" onClick={() => setEditing(false)}>{t('Cancel')}</button>
                          </div>
                        </div>
                      ) : adding ? (
                        <div className="space-y-2">
                          <textarea
                            className="input w-full text-sm leading-relaxed"
                            rows={2}
                            value={addDraft}
                            autoFocus
                            placeholder={t('Text of the new sentence')}
                            onChange={e => setAddDraft(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addAfter(m);
                              if (e.key === 'Escape') setAdding(false);
                            }}
                          />
                          <div className="flex items-center gap-2">
                            <button className="btn-primary text-xs py-1 px-3" onClick={() => addAfter(m)}>{t('Add & render')}</button>
                            <button className="btn-secondary text-xs py-1 px-3" onClick={() => setAdding(false)}>{t('Cancel')}</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <button className="btn-secondary text-xs py-1 px-3" disabled={busy} onClick={() => { setEditing(true); setDraft(m.text); }}>
                            {t('Edit text')}
                          </button>
                          <button className="btn-secondary text-xs py-1 px-3" disabled={busy} onClick={() => setAdding(true)}>
                            {t('Add sentence after')}
                          </button>
                          <button className="btn-primary text-xs py-1 px-3" disabled={busy || (!!overrideModel && !overrideVoice)} onClick={() => regenerate(m)}>
                            {t('Re-render')}
                          </button>
                          <select
                            className="input text-xs py-1 w-auto"
                            value={overrideModel}
                            onChange={e => setOverrideModel(e.target.value)}
                            title={t('Render with another model')}
                          >
                            <option value="">{t('Same voice')}</option>
                            {models.map(mo => <option key={mo.id} value={mo.id}>{mo.label}</option>)}
                          </select>
                          {overrideModel && (
                            <select
                              className="input text-xs py-1 w-auto"
                              value={overrideVoice}
                              onChange={e => setOverrideVoice(e.target.value)}
                            >
                              {overrideVoices.map(v => <option key={v} value={v}>{v}</option>)}
                            </select>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
