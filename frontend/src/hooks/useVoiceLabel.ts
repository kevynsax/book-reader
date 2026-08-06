import { useEffect, useState } from 'react';
import { bareVoice, engineOf, friendlyVoice } from '../lib/format';

// The backend owns every voice name (engine -> voice id -> name) and serves the
// whole table from /api/voice-names, so a label never depends on which TTS
// server answered a probe. One fetch per session, shared by every chip.
type NameTable = Record<string, Record<string, string>>;

let table: NameTable | null = null;
let inflight: Promise<NameTable> | null = null;

function loadNames(): Promise<NameTable> {
  if (table) return Promise.resolve(table);
  if (!inflight) {
    inflight = fetch('/api/voice-names')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { names?: NameTable } | null) => {
        const nm = d?.names && typeof d.names === 'object' ? d.names : {};
        if (Object.keys(nm).length === 0) throw new Error('no names');
        table = nm;
        return nm;
      })
      .catch(err => {
        inflight = null;
        throw err;
      });
  }
  return inflight;
}

// The whole table, for pickers that offer every voice the fleet can speak.
export function useVoiceNames(): NameTable {
  return useNameTable();
}

// Resolve a composite "engine:voice" to its human label.
export function useVoiceLabel(_voices?: string[]): (composite: string) => string {
  const names = useNameTable();
  return (composite: string) =>
    names[engineOf(composite)]?.[bareVoice(composite)] ?? friendlyVoice(composite);
}

function useNameTable(): NameTable {
  const [names, setNames] = useState<NameTable>(() => table ?? {});

  useEffect(() => {
    if (table) return;
    let cancelled = false;
    let timer = 0;
    const attempt = (n: number) => {
      loadNames()
        .then(nm => { if (!cancelled) setNames(nm); })
        .catch(() => {
          if (cancelled || n >= 4) return;
          timer = window.setTimeout(() => attempt(n + 1), 3000 * (n + 1));
        });
    };
    attempt(0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  return names;
}
