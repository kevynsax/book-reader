import { useEffect, useState } from 'react';

interface Props {
  // Voices the book already has — excluded from the picker.
  existing: string[];
  onAdd: (voice: string) => void;
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

export default function AddVoiceModal({ existing, onAdd, onClose }: Props) {
  const [allVoices, setAllVoices] = useState<string[]>(FALLBACK_VOICES);
  const [lang, setLang] = useState('pt');

  useEffect(() => {
    fetch('/api/voices')
      .then(r => r.json())
      .then((v: unknown) => { if (Array.isArray(v) && v.length) setAllVoices(v as string[]); })
      .catch(() => {});
  }, []);

  const langDef = VOICE_LANGS.find(l => l.id === lang)!;
  const available = allVoices.filter(v =>
    langDef.prefixes.some(p => v.startsWith(p + '_')) && !existing.includes(v)
  );
  const female = available.filter(v => v[1] === 'f');
  const male   = available.filter(v => v[1] === 'm');

  const Section = ({ title, voices }: { title: string; voices: string[] }) =>
    voices.length === 0 ? null : (
      <div>
        <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">{title}</p>
        <div className="grid grid-cols-3 gap-2">
          {voices.map(v => (
            <button
              key={v}
              className="px-3 py-2 rounded-lg text-sm bg-gray-800 text-gray-200 hover:bg-amber-600/20 hover:text-amber-400 transition-colors"
              onClick={() => onAdd(v)}
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
      <div className="bg-gray-900 rounded-2xl border border-gray-700 w-full max-w-md shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <h2 className="font-semibold text-gray-100">Add a voice</h2>
          <button className="text-gray-500 hover:text-gray-300 text-xl leading-none" onClick={onClose}>×</button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <select className="input" value={lang} onChange={e => setLang(e.target.value)}>
            {VOICE_LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>

          {available.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-4">No more voices available in this language.</p>
          ) : (
            <>
              <Section title="Female" voices={female} />
              <Section title="Male" voices={male} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
