import { useEffect, useRef, useState } from 'react';
import { friendlyVoice } from '../lib/format';
import { TtsModel } from '../types';
import ServerStatus from './ServerStatus';

interface Props {
  bookId: string;
  initialVoice?: string;
  exclude?: string[];
  onConfirm: (voices: string[]) => void;
  onClose: () => void;
}

const VOICE_LANGS = [
  { id: 'pt', label: 'Portuguese' },
  { id: 'en', label: 'English' },
];

const FALLBACK_MODELS: TtsModel[] = [
  { id: 'chatterbox', label: 'Chatterbox' },
  { id: 'openaudio', label: 'OpenAudio (Fish)' },
  { id: 'kokoro', label: 'Kokoro' },
];

// Engine id for a (possibly legacy/unprefixed) composite voice.
function engineOf(composite: string): string {
  const sep = composite.indexOf(':');
  if (sep > 0 && FALLBACK_MODELS.some(m => m.id === composite.slice(0, sep))) return composite.slice(0, sep);
  if (composite === 'default' || /^[a-z]{2}-[A-Z]{2}-/.test(composite)) return 'chatterbox';
  if (/^[a-z]{2}_/.test(composite)) return 'kokoro';
  return 'chatterbox';
}

// Language a bare voice belongs to, per engine (Kokoro encodes it in the prefix).
function langOfVoice(model: string, v: string): string {
  if (model === 'kokoro') return v.startsWith('pf') || v.startsWith('pm') ? 'pt' : 'en';
  return v.startsWith('pt-') ? 'pt' : 'en';
}

export default function GenerateVoiceModal({ bookId, initialVoice, exclude, onConfirm, onClose }: Props) {
  const [models, setModels]   = useState<TtsModel[]>(FALLBACK_MODELS);
  const [model, setModel]     = useState(initialVoice ? engineOf(initialVoice) : 'chatterbox');
  const [allVoices, setAllVoices] = useState<string[]>([]);
  const [voicesState, setVoicesState] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [lang, setLang]       = useState('pt');
  const [selected, setSelected]   = useState<Set<string>>(new Set()); // composites "engine:voice"
  const [preview, setPreview]     = useState<string>(''); // composite currently sampled
  const [sampleState, setSampleState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [playing, setPlaying]     = useState(false);
  const [progress, setProgress]   = useState(0);

  const audioRef = useRef<HTMLAudioElement>(null);
  const urlRef   = useRef<string | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then((m: unknown) => { if (Array.isArray(m) && m.length) setModels(m as TtsModel[]); })
      .catch(() => {});
  }, []);

  // Load voices whenever the selected model changes.
  useEffect(() => {
    let cancelled = false;
    setAllVoices([]); setPreview(''); setSampleState('idle'); setVoicesState('loading');
    fetch(`/api/models/${model}/voices`)
      .then(r => (r.ok ? r.json() : { available: false, voices: [] }))
      .then((data: { available?: boolean; voices?: string[] }) => {
        if (cancelled) return;
        if (data.available === false) { setVoicesState('offline'); return; }
        const list = Array.isArray(data.voices) ? data.voices : [];
        setAllVoices(list);
        setVoicesState('ready');
        // Keep the current language if it has voices, otherwise switch.
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

  const filtered = allVoices.filter(
    v => langOfVoice(model, v) === lang && !exclude?.includes(`${model}:${v}`),
  );

  const toggleVoice = (voice: string) => {
    const composite = `${model}:${voice}`;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(composite)) next.delete(composite);
      else next.add(composite);
      return next;
    });
    loadSample(composite);
  };

  const loadSample = async (composite: string) => {
    setPreview(composite);
    setSampleState('loading');
    setPlaying(false);
    setProgress(0);
    const reqId = ++reqIdRef.current;
    try {
      const res = await fetch(`/api/books/${bookId}/sample?voice=${encodeURIComponent(composite)}`);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (reqId !== reqIdRef.current) return;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(blob);
      setSampleState('ready');
      const audio = audioRef.current;
      if (audio) audio.src = urlRef.current;
    } catch {
      if (reqId === reqIdRef.current) setSampleState('error');
    }
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || sampleState !== 'ready') return;
    if (playing) audio.pause();
    else audio.play().catch(() => {});
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-gray-900 rounded-2xl border border-gray-700 w-full max-w-md shadow-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <div>
            <h2 className="font-semibold text-gray-100">Choose voices</h2>
            <p className="text-xs text-gray-500 mt-0.5">Pick one or more readers across models. Tap to select and preview.</p>
          </div>
          <button className="text-gray-500 hover:text-gray-300 text-xl leading-none" onClick={onClose}>×</button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <ServerStatus />

          <div>
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Model</p>
            <div className="flex flex-wrap gap-2">
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
            </div>
          </div>

          {voicesState !== 'offline' && (
            <select className="input" value={lang} onChange={e => setLang(e.target.value)}>
              {VOICE_LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          )}

          {voicesState === 'offline' ? (
            <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-sm">
              <p className="text-amber-300 font-medium">This model is offline</p>
              <p className="text-amber-200/70 mt-1">
                The {models.find(m => m.id === model)?.label ?? model} server isn’t reachable
                right now (it may be a laptop that’s turned off). Try again later or pick another model.
              </p>
            </div>
          ) : voicesState === 'loading' ? (
            <p className="text-sm text-gray-500">Checking model…</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-gray-500">No voices for this model and language.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {filtered.map(v => {
                const composite = `${model}:${v}`;
                const isSelected = selected.has(composite);
                const isPreview = composite === preview;
                return (
                  <button
                    key={v}
                    className={`relative px-3 py-2 rounded-lg text-sm transition-colors ${
                      isSelected
                        ? 'bg-amber-600/20 text-amber-400 ring-1 ring-amber-500'
                        : isPreview
                          ? 'bg-gray-800 text-gray-200 ring-1 ring-gray-500'
                          : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                    }`}
                    onClick={() => toggleVoice(v)}
                  >
                    {isSelected && (
                      <span className="absolute top-1 right-1 text-amber-400 text-xs leading-none">✓</span>
                    )}
                    {friendlyVoice(v)}
                  </button>
                );
              })}
            </div>
          )}

          {selected.size > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Selected ({selected.size})</p>
              <div className="flex flex-wrap gap-2">
                {[...selected].map(composite => (
                  <span
                    key={composite}
                    className="inline-flex items-center gap-1.5 rounded-full pl-3 pr-2 py-1 text-xs border border-amber-500/60 bg-amber-600/10 text-amber-300"
                  >
                    {friendlyVoice(composite.slice(composite.indexOf(':') + 1))}
                    <button
                      className="text-amber-400/60 hover:text-red-400 leading-none text-sm"
                      onClick={() => setSelected(prev => { const n = new Set(prev); n.delete(composite); return n; })}
                      title="Remove"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <audio
          ref={audioRef}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setProgress(0); }}
          onTimeUpdate={() => {
            const a = audioRef.current;
            if (a && a.duration) setProgress(a.currentTime / a.duration);
          }}
        />

        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-800 shrink-0">
          <button
            className="btn-secondary relative overflow-hidden flex items-center gap-2 disabled:opacity-40"
            onClick={togglePlay}
            disabled={!preview || sampleState === 'loading' || sampleState === 'error'}
            title="Play sample"
          >
            <span
              className="absolute inset-y-0 left-0 bg-amber-500/30 pointer-events-none"
              style={{ width: `${progress * 100}%` }}
            />
            <span className="relative z-10 flex items-center gap-2">
              {sampleState === 'loading' ? (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
              ) : playing ? (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
              ) : (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              )}
              {sampleState === 'error' ? 'Sample failed' : 'Sample'}
            </span>
          </button>

          <button
            className="btn-primary flex-1 justify-center disabled:opacity-40"
            onClick={() => selected.size && onConfirm([...selected])}
            disabled={!selected.size}
          >
            {selected.size > 1 ? `Generate ${selected.size} voices` : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  );
}
