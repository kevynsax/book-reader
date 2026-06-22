import { useEffect, useState } from 'react';
import { TtsServer } from '../types';
import { friendlyVoice } from '../lib/format';

function modelLabel(s: TtsServer): string {
  if (!s.activeModel) return '';
  return s.models.find(m => m.id === s.activeModel)?.label ?? s.activeModel;
}

export default function ServerStatus({ pollMs = 15000 }: { pollMs?: number }) {
  const [servers, setServers] = useState<TtsServer[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/servers')
        .then(r => (r.ok ? r.json() : []))
        .then((data: unknown) => { if (!cancelled && Array.isArray(data)) { setServers(data as TtsServer[]); setLoaded(true); } })
        .catch(() => { if (!cancelled) setLoaded(true); });
    };
    load();
    const t = setInterval(load, pollMs);
    return () => { cancelled = true; clearInterval(t); };
  }, [pollMs]);

  if (!loaded || servers.length === 0) return null;

  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Servers</p>
      <div className="flex flex-wrap gap-2">
        {servers.map(s => {
          const loading = s.online && s.state === 'loading';
          const model = modelLabel(s);
          return (
            <span
              key={s.id}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs border ${
                s.online
                  ? 'border-gray-700 bg-gray-800 text-gray-300'
                  : 'border-gray-800 bg-gray-900 text-gray-600'
              }`}
              title={s.online ? `${s.url} — ${s.state ?? 'online'}${model ? ` (${friendlyVoice(model)})` : ''}` : `${s.url} — offline`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  loading ? 'bg-amber-400 animate-pulse' : s.online ? 'bg-emerald-400' : 'bg-gray-600'
                }`}
              />
              {s.label}
              {s.online && model && <span className="text-gray-500">· {model}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
