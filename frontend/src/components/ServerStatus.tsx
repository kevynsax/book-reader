import { useEffect, useState } from 'react';
import { TtsServer } from '../types';
import { useVoiceLabel } from '../hooks/useVoiceLabel';
import { t } from '../i18n';

function modelLabel(s: TtsServer, id?: string): string {
  if (!id) return '';
  return s.models.find(m => m.id === id)?.label ?? id;
}

// What a busy non-tts worker is doing, per role.
const BUSY_VERB: Record<string, () => string> = {
  vlm: () => t('reading pages'),
  slm: () => t('splitting text'),
  whisper: () => t('verifying audio'),
};

const ROLE_TAG: Record<string, () => string> = {
  vlm: () => t('Page reader'),
  slm: () => t('Text splitter'),
  whisper: () => t('Audio checker'),
};

// "renderizando Mateus: 'E, antes, a disciplina teologica…'" when the render's
// voice/sentence are known, falling back to the model name. The voice label
// comes from the model's own names map (useVoiceLabel) so it matches the name
// shown on the voice's progress card, not the raw clone id.
function renderingLabel(s: TtsServer, voiceLabel: (composite: string) => string): string {
  const subject = s.renderingVoice
    ? voiceLabel(`${s.rendering ?? ''}:${s.renderingVoice}`)
    : modelLabel(s, s.rendering);
  const text = s.renderingText ? `: '${s.renderingText}'` : '';
  return `${t('rendering')}${subject ? ` ${subject}` : ''}${text}`;
}

export default function ServerStatus({
  pollMs = 5000,
  roles = ['tts'],
  onServers,
}: {
  pollMs?: number;
  /** Which worker roles to show (chips group in this order). */
  roles?: ('tts' | 'vlm' | 'slm' | 'whisper')[];
  onServers?: (servers: TtsServer[]) => void;
}) {
  const [servers, setServers] = useState<TtsServer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const voiceLabel = useVoiceLabel(
    servers.filter(s => s.rendering && s.renderingVoice).map(s => `${s.rendering}:${s.renderingVoice}`),
  );

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

  const shown = servers.filter(s => roles.includes((s.role ?? 'tts') as 'tts'));
  if (!loaded || shown.length === 0) return null;

  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">{t('Servers')}</p>
      <div className="flex flex-col gap-1.5 items-start">
        {shown.map(s => {
          const role = s.role ?? 'tts';
          const isTts = role === 'tts';
          const loading = s.online && s.state === 'loading';
          const rendering = isTts && s.online && !!s.rendering;
          const busy = rendering || (!isTts && s.online && !!s.busy);
          const model = modelLabel(s, s.activeModel);
          const busyText = rendering
            ? renderingLabel(s, voiceLabel)
            : `${BUSY_VERB[role]?.() ?? t('working')}${s.task ? ` ${s.task}` : ''}`;
          const avgUnit = role === 'tts' ? t('s/sentence') : role === 'vlm' ? t('s/page') : t('s/task');
          return (
            <span
              key={`${role}-${s.id}`}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs border max-w-full ${
                busy
                  ? 'border-amber-700/60 bg-amber-950/30 text-amber-200'
                  : s.online
                    ? 'border-gray-700 bg-gray-800 text-gray-300'
                    : 'border-gray-800 bg-gray-900 text-gray-600'
              }`}
              title={s.online ? `${s.url} — ${busy ? busyText : s.state ?? t('online')}` : t('{url} — offline', { url: s.url })}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  busy || loading ? 'bg-amber-400 animate-pulse' : s.online ? 'bg-emerald-400' : 'bg-gray-600'
                }`}
              />
              {!isTts && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 shrink-0">
                  {ROLE_TAG[role]?.() ?? role}
                </span>
              )}
              <span className="shrink-0">{s.label}</span>
              {busy && <span className="text-amber-400/90 truncate">· {busyText}</span>}
              {!busy && isTts && s.online && model && <span className="text-gray-500 truncate">· {model}</span>}
              {s.online && s.avgRenderSecs != null && (
                <span className="text-gray-500 shrink-0" title={t('{n} tasks completed', { n: s.renders ?? 0 })}>
                  · {s.avgRenderSecs.toFixed(1)}{avgUnit}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
