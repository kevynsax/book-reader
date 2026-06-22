import { TTS_SERVERS, TtsServerConfig } from '../config.js';

export type TtsServer = TtsServerConfig;

export interface CatalogModel { id: string; label: string; repo?: string; active: boolean; }

export interface ServerStatus {
  id: string;
  label: string;
  url: string;
  online: boolean;
  state?: string;       // loading | ready | error
  activeModel?: string; // catalog key of the loaded model
  backend?: string;
  error?: string | null;
  models: { id: string; label: string }[];
}

export function getServers(): TtsServer[] {
  return TTS_SERVERS;
}

const PROBE_TIMEOUT = 4000;

async function getJson(url: string, timeout = PROBE_TIMEOUT): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchCatalog(server: TtsServer): Promise<CatalogModel[]> {
  const data = await getJson(`${server.url}/v1/models`) as { data?: unknown } | null;
  const arr = data && Array.isArray(data.data) ? data.data : [];
  return arr
    .map((m: Record<string, unknown>) => ({
      id: String(m.id ?? ''),
      label: String(m.label ?? m.id ?? ''),
      repo: typeof m.repo === 'string' ? m.repo : undefined,
      active: m.active === true,
    }))
    .filter(m => m.id);
}

interface Health { online: boolean; state?: string; model?: string; backend?: string; error?: string | null; }

export async function fetchHealth(server: TtsServer, timeout = PROBE_TIMEOUT): Promise<Health> {
  const data = await getJson(`${server.url}/health`, timeout) as Record<string, unknown> | null;
  if (!data) return { online: false };
  return {
    online: true,
    state: typeof data.state === 'string' ? data.state : undefined,
    model: typeof data.model === 'string' ? data.model : undefined,
    backend: typeof data.backend === 'string' ? data.backend : undefined,
    error: (data.error as string) ?? null,
  };
}

export async function serverStatus(server: TtsServer): Promise<ServerStatus> {
  const [health, catalog] = await Promise.all([fetchHealth(server), fetchCatalog(server)]);
  return {
    id: server.id,
    label: server.label,
    url: server.url,
    online: health.online,
    state: health.state,
    activeModel: catalog.find(m => m.active)?.id,
    backend: health.backend,
    error: health.error,
    models: catalog.map(m => ({ id: m.id, label: m.label })),
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Wait until the server reports `ready` with `modelId` active (or fail).
async function pollReady(server: TtsServer, modelId: string, timeoutMs = 180_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = await fetchHealth(server);
    if (!health.online) return false;
    if (health.state === 'error') return false;
    if (health.state === 'ready') {
      const catalog = await fetchCatalog(server);
      if (catalog.find(m => m.active)?.id === modelId) return true;
    }
    await sleep(2000);
  }
  return false;
}

// Ensure `modelId` is loaded and ready on this server, hot-swapping if needed.
// Returns false when the server is offline or the model fails to load.
export async function ensureModelLoaded(server: TtsServer, modelId: string): Promise<boolean> {
  const health = await fetchHealth(server);
  if (!health.online) return false;

  const catalog = await fetchCatalog(server);
  const active = catalog.find(m => m.active);
  if (health.state === 'ready' && active?.id === modelId) return true;

  try {
    const res = await fetch(`${server.url}/v1/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(10_000),
    });
    // 409 == already loading (someone else asked); fall through to polling.
    if (!res.ok && res.status !== 409) return false;
  } catch {
    return false;
  }
  return pollReady(server, modelId);
}

// Return the online servers, each with `modelId` loaded and ready. Loads happen
// in parallel so both machines warm up at once.
export async function readyServersFor(modelId: string): Promise<TtsServer[]> {
  const servers = getServers();
  const results = await Promise.all(
    servers.map(async s => ((await ensureModelLoaded(s, modelId)) ? s : null)),
  );
  return results.filter((s): s is TtsServer => s !== null);
}

// Pick a single ready server for a one-off request (e.g. a voice sample).
export async function pickReadyServer(modelId: string): Promise<TtsServer | null> {
  for (const server of getServers()) {
    if (await ensureModelLoaded(server, modelId)) return server;
  }
  return null;
}
