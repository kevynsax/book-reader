import { useEffect, useState } from 'react';
import { TtsServer } from '../types';
import { friendlyVoice } from '../lib/format';
import { t } from '../i18n';

function modelLabel(s: TtsServer, id?: string): string {
  if (!id) return '';
  return s.models.find(m => m.id === id)?.label ?? id;
}

export default function ServerStatus({ pollMs = 5000 }: { pollMs?: number }) {
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
      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">{t('Servers')}</p>
      <div className="flex flex-wrap gap-2">
        {servers.map(s => {
          const loading = s.online && s.state === 'loading';
          const rendering = s.online && !!s.rendering;
          const model = modelLabel(s, s.rendering ?? s.activeModel);
          return (
            <span
              key={s.id}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs border ${
                rendering
                  ? 'border-amber-700/60 bg-amber-950/30 text-amber-200'
                  : s.online
                    ? 'border-gray-700 bg-gray-800 text-gray-300'
                    : 'border-gray-800 bg-gray-900 text-gray-600'
              }`}
              title={s.online ? `${s.url} — ${rendering ? t('rendering') : s.state ?? t('online')}${model ? ` (${friendlyVoice(model)})` : ''}` : t('{url} — offline', { url: s.url })}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  rendering || loading ? 'bg-amber-400 animate-pulse' : s.online ? 'bg-emerald-400' : 'bg-gray-600'
                }`}
              />
              {s.label}
              {rendering && <span className="text-amber-400/90">· {t('rendering')}{model ? ` ${model}` : ''}</span>}
              {!rendering && s.online && model && <span className="text-gray-500">· {model}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
