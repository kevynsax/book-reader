import { useEffect, useRef, useState } from 'react';

interface Props {
  bookId: string;
  initialVoice?: string;
  exclude?: string[];
  onConfirm: (voice: string) => void;
  onClose: () => void;
}

const VOICE_LANGS = [
  { id: 'pt', label: 'Portuguese', prefixes: ['pf', 'pm'] },
  { id: 'en', label: 'English',    prefixes: ['af', 'am', 'bf', 'bm', 'ef', 'em'] },
];

const FALLBACK_VOICES = [
  'af_heart','af_bella','af_nicole','af_nova','af_sarah',
  'am_adam','am_echo','am_michael','am_onyx',
  'pf_dora','pm_alex','pm_santa',
];

function capFirst(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }
function voiceName(v: string) { return capFirst(v.split('_').slice(1).join(' ')); }
function langOf(v: string) {
  return VOICE_LANGS.find(l => l.prefixes.some(p => v.startsWith(p + '_')))?.id ?? 'pt';
}

export default function GenerateVoiceModal({ bookId, initialVoice, exclude, onConfirm, onClose }: Props) {
  const [allVoices, setAllVoices] = useState<string[]>(FALLBACK_VOICES);
  const [lang, setLang]           = useState(initialVoice ? langOf(initialVoice) : 'pt');
  const [selected, setSelected]   = useState<string>('');
  const [sampleState, setSampleState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [playing, setPlaying]     = useState(false);
  const [progress, setProgress]   = useState(0);

  const audioRef = useRef<HTMLAudioElement>(null);
  const urlRef   = useRef<string | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    fetch('/api/voices')
      .then(r => r.json())
      .then((v: unknown) => { if (Array.isArray(v) && v.length) setAllVoices(v as string[]); })
      .catch(() => {});
  }, []);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const langDef  = VOICE_LANGS.find(l => l.id === lang)!;
  const filtered = allVoices.filter(v =>
    langDef.prefixes.some(p => v.startsWith(p + '_')) && !exclude?.includes(v)
  );
  const female   = filtered.filter(v => v[1] === 'f');
  const male     = filtered.filter(v => v[1] === 'm');

  const selectVoice = async (voice: string) => {
    setSelected(voice);
    setSampleState('loading');
    setPlaying(false);
    setProgress(0);
    const reqId = ++reqIdRef.current;
    try {
      const res = await fetch(`/api/books/${bookId}/sample?voice=${encodeURIComponent(voice)}`);
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

  const Section = ({ title, voices }: { title: string; voices: string[] }) =>
    voices.length === 0 ? null : (
      <div>
        <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">{title}</p>
        <div className="grid grid-cols-3 gap-2">
          {voices.map(v => (
            <button
              key={v}
              className={`px-3 py-2 rounded-lg text-sm transition-colors ${
                v === selected
                  ? 'bg-amber-600/20 text-amber-400 ring-1 ring-amber-500'
                  : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
              }`}
              onClick={() => selectVoice(v)}
            >
              {voiceName(v)}
            </button>
          ))}
        </div>
      </div>
    );

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-gray-900 rounded-2xl border border-gray-700 w-full max-w-md shadow-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <div>
            <h2 className="font-semibold text-gray-100">Choose a voice</h2>
            <p className="text-xs text-gray-500 mt-0.5">Pick a reader and preview it on the first paragraph.</p>
          </div>
          <button className="text-gray-500 hover:text-gray-300 text-xl leading-none" onClick={onClose}>×</button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <select className="input" value={lang} onChange={e => setLang(e.target.value)}>
            {VOICE_LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          <Section title="Female" voices={female} />
          <Section title="Male" voices={male} />
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
            disabled={!selected || sampleState === 'loading' || sampleState === 'error'}
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
            onClick={() => selected && onConfirm(selected)}
            disabled={!selected}
          >
            Generate
          </button>
        </div>
      </div>
    </div>
  );
}
