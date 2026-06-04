import { useRef, useEffect, useState } from 'react';
import { UploadFormData } from '../../types';

interface Props {
  data: UploadFormData;
  onChange: (patch: Partial<UploadFormData>) => void;
  onNext: () => void;
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

export default function Step1BookInfo({ data, onChange, onNext }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [allVoices, setAllVoices] = useState<string[]>(FALLBACK_VOICES);
  const [lang, setLang] = useState('pt');

  useEffect(() => {
    fetch('/api/voices')
      .then(r => r.json())
      .then((v: unknown) => { if (Array.isArray(v) && v.length) setAllVoices(v as string[]); })
      .catch(() => {});
  }, []);

  const langDef = VOICE_LANGS.find(l => l.id === lang)!;
  const filtered = allVoices.filter(v => langDef.prefixes.some(p => v.startsWith(p + '_')));
  const female   = filtered.filter(v => v[1] === 'f');
  const male     = filtered.filter(v => v[1] === 'm');

  // Auto-select first voice when lang changes
  useEffect(() => {
    const first = filtered[0];
    if (first && !filtered.includes(data.voice)) onChange({ voice: first });
  }, [lang, allVoices]); // eslint-disable-line react-hooks/exhaustive-deps

  const canProceed = data.file !== null;

  return (
    <div className="space-y-5">
      <div>
        <label className="label">PDF file</label>
        <div
          className="border-2 border-dashed border-gray-700 rounded-lg p-8 text-center cursor-pointer hover:border-amber-600 transition-colors"
          onClick={() => fileRef.current?.click()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type === 'application/pdf') onChange({ file: f }); }}
          onDragOver={e => e.preventDefault()}
        >
          {data.file ? (
            <div>
              <svg className="w-8 h-8 text-amber-500 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-gray-300 font-medium">{data.file.name}</p>
              <p className="text-gray-500 text-sm">{(data.file.size / 1024 / 1024).toFixed(1)} MB</p>
            </div>
          ) : (
            <div>
              <svg className="w-8 h-8 text-gray-600 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-gray-400">Drop a PDF here or <span className="text-amber-500">browse</span></p>
              <p className="text-gray-600 text-sm mt-1">PDF only</p>
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" accept="application/pdf" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) onChange({ file: f }); }} />
      </div>

      {/* Voice selection */}
      <div>
        <label className="label">Reading voice</label>
        <div className="grid grid-cols-2 gap-2">
          <select className="input" value={lang} onChange={e => setLang(e.target.value)}>
            {VOICE_LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          <select className="input" value={data.voice} onChange={e => onChange({ voice: e.target.value })}>
            {female.length > 0 && (
              <optgroup label="Female">
                {female.map(v => <option key={v} value={v}>{voiceName(v)}</option>)}
              </optgroup>
            )}
            {male.length > 0 && (
              <optgroup label="Male">
                {male.map(v => <option key={v} value={v}>{voiceName(v)}</option>)}
              </optgroup>
            )}
          </select>
        </div>
      </div>

      <button className="btn-primary w-full justify-center" disabled={!canProceed} onClick={onNext}>
        Next: Select pages
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}
