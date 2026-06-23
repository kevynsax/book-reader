import { TTS_SERVER_COOLDOWN_MS } from '../config.js';
import { TtsServer, ensureModelLoaded } from './ttsServers.js';

interface PoolEntry {
  server: TtsServer;
  inFlight: number;
  // Epoch ms until which this server is parked after an error; 0 = healthy.
  downUntil: number;
}

// A live, shared view of which TTS servers are usable right now, balancing work
// across them per request. The state is mutated on every dispatch and error so a
// server that throws is parked for a cooldown (and later re-probed) while the
// healthy ones keep taking work — instead of being chosen once up front.
export class TtsServerPool {
  private entries: PoolEntry[];

  constructor(servers: TtsServer[], private modelId: string) {
    this.entries = servers.map(server => ({ server, inFlight: 0, downUntil: 0 }));
  }

  get size(): number {
    return this.entries.length;
  }

  // Reserve the least-loaded server that's healthy now and not already tried for
  // this request. Returns null when every candidate is busy-tried or parked.
  private take(exclude: Set<string>, now: number): PoolEntry | null {
    const free = this.entries
      .filter(e => e.downUntil <= now && !exclude.has(e.server.id))
      .sort((a, b) => a.inFlight - b.inFlight);
    if (free.length === 0) return null;
    free[0].inFlight++;
    return free[0];
  }

  // Last resort for a single request: re-probe one parked-and-not-yet-tried
  // server. If its model is loaded again, clear the cooldown so it's usable.
  private async revive(exclude: Set<string>, now: number): Promise<boolean> {
    const parked = this.entries.find(e => e.downUntil > now && !exclude.has(e.server.id));
    if (!parked) return false;
    const ok = await ensureModelLoaded(parked.server, this.modelId);
    parked.downUntil = ok ? 0 : now + TTS_SERVER_COOLDOWN_MS;
    return ok;
  }

  // Run `fn` against a balanced server, falling back to the others if it throws.
  // Each failing server is parked so concurrent and later calls skip it. Throws
  // the last error only when no server can complete the request.
  async run<T>(fn: (server: TtsServer) => Promise<T>): Promise<T> {
    const tried = new Set<string>();
    let lastErr: unknown;
    for (;;) {
      const now = Date.now();
      const entry = this.take(tried, now);
      if (!entry) {
        if (await this.revive(tried, now)) continue;
        break;
      }
      try {
        return await fn(entry.server);
      } catch (err) {
        lastErr = err;
        entry.downUntil = Date.now() + TTS_SERVER_COOLDOWN_MS;
        tried.add(entry.server.id);
      } finally {
        entry.inFlight = Math.max(0, entry.inFlight - 1);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('No TTS server available');
  }
}

// Run `items` through `worker` with at most `concurrency` calls in flight.
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}
