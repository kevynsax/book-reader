import { useEffect, useState } from 'react';
import { TtsServer } from '../types';
import { friendlyVoice } from '../lib/format';
import { t } from '../i18n';

function modelLabel(s: TtsServer, id?: string): string {
  if (!id) return '';
  return s.models.find(m => m.id === id)?.label ?? id;
}

// "renderizando Mateus: 'E, antes, a disciplina teologica…'" when the render's
// voice/sentence are known, falling back to the model name.
function renderingLabel(s: TtsServer): string {
  const subject = s.renderingVoice ? friendlyVoice(s.renderingVoice) : modelLabel(s, s.rendering);
  const text = s.renderingText ? `: '${s.renderingText}'` : '';
  return `${t('rendering')}${subject ? ` ${subject}` : ''}${text}`;
}

export default function ServerStatus({ pollMs = 5000, onServers }: { pollMs?: number; onServers?: (servers: TtsServer[]) => void }) {
  const [servers, setServers] = useState<TtsServer[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/servers')
        .then(r => (r.ok ? r.json() : []))
        .then((data: unknown) => {
          if (!cancelled && Array.isArray(data)) {
            setServers(data as TtsServer[]);
            setLoaded(true);
            onServers?.(data as TtsServer[]);
          }
        })
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
      <div className="flex flex-col gap-1.5 items-start">
        {servers.map(s => {
          const loading = s.online && s.state === 'loading';
          const rendering = s.online && !!s.rendering;
          const model = modelLabel(s, s.activeModel);
          return (
            <span
              key={s.id}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs border max-w-full ${
                rendering
                  ? 'border-amber-700/60 bg-amber-950/30 text-amber-200'
                  : s.online
                    ? 'border-gray-700 bg-gray-800 text-gray-300'
                    : 'border-gray-800 bg-gray-900 text-gray-600'
              }`}
              title={s.online ? `${s.url} — ${rendering ? renderingLabel(s) : s.state ?? t('online')}` : t('{url} — offline', { url: s.url })}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  rendering || loading ? 'bg-amber-400 animate-pulse' : s.online ? 'bg-emerald-400' : 'bg-gray-600'
                }`}
              />
              <span className="shrink-0">{s.label}</span>
              {rendering && <span className="text-amber-400/90 truncate">· {renderingLabel(s)}</span>}
              {!rendering && s.online && model && <span className="text-gray-500 truncate">· {model}</span>}
              {s.online && s.avgRenderSecs != null && (
                <span className="text-gray-500 shrink-0" title={t('{n} sentences rendered', { n: s.renders ?? 0 })}>
                  · {s.avgRenderSecs.toFixed(1)}{t('s/sentence')}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
