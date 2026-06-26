import { useEffect, useState } from 'react';
import { bareVoice, engineOf, friendlyVoice } from '../lib/format';

// Display names come from each model's /voices endpoint (names: bareId -> label).
// Cache per engine so chips across the app share one fetch and re-render instantly.
const cache = new Map<string, Record<string, string>>();

// Resolve a composite "engine:voice" to its human label, preferring the
// server-provided name and falling back to client-side formatting.
export function useVoiceLabel(voices: string[]): (composite: string) => string {
  const engines = [...new Set(voices.map(engineOf))];
  const [names, setNames] = useState<Record<string, Record<string, string>>>(
    () => Object.fromEntries(engines.filter(e => cache.has(e)).map(e => [e, cache.get(e)!])),
  );

  useEffect(() => {
    let cancelled = false;
    for (const engine of engines) {
      if (cache.has(engine)) continue;
      fetch(`/api/models/${engine}/voices`)
        .then(r => (r.ok ? r.json() : null))
        .then((d: { names?: Record<string, string> } | null) => {
          const nm = d?.names && typeof d.names === 'object' ? d.names : {};
          cache.set(engine, nm);
          if (!cancelled) setNames(prev => ({ ...prev, [engine]: nm }));
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engines.join(',')]);

  return (composite: string) => names[engineOf(composite)]?.[bareVoice(composite)] ?? friendlyVoice(composite);
}
