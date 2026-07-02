import { TTS_SERVER_CONCURRENCY, TTS_SERVER_COOLDOWN_MS, TTS_SERVER_PROBE_MS } from '../config.js';
import { TtsServer, ensureModelLoaded } from './ttsServers.js';

interface PoolEntry {
  server: TtsServer;
  inFlight: number;
  // Epoch ms until which this server is parked after an error; 0 = healthy.
  downUntil: number;
}

interface PoolOptions {
  // Ids of servers known ready at construction; any configured server not listed
  // starts parked, so a server that was offline at chapter start can still be
  // brought in by the background re-probe once it reconnects.
  readyIds?: Set<string>;
  // Background re-probe cadence (ms); defaults to TTS_SERVER_PROBE_MS, 0 disables.
  probeMs?: number;
}

// A live, shared view of which TTS servers are usable right now, balancing work
// across them per request. The state is mutated on every dispatch and error so a
// server that throws is parked for a cooldown (and later re-probed) while the
// healthy ones keep taking work — instead of being chosen once up front. A
// background timer re-probes parked servers so a reconnected one rejoins mid-run
// rather than waiting for the next chapter's server snapshot.
export class TtsServerPool {
  private entries: PoolEntry[];
  private timer?: ReturnType<typeof setInterval>;
  private probing = false;
  private waiters: (() => void)[] = [];

  constructor(servers: TtsServer[], private modelId: string, opts: PoolOptions = {}) {
    const { readyIds } = opts;
    this.entries = servers.map(server => ({
      server,
      inFlight: 0,
      downUntil: readyIds && !readyIds.has(server.id) ? Date.now() + TTS_SERVER_COOLDOWN_MS : 0,
    }));
    const probeMs = opts.probeMs ?? TTS_SERVER_PROBE_MS;
    if (probeMs > 0) {
      this.timer = setInterval(() => { void this.reprobe(); }, probeMs);
      this.timer.unref?.();
    }
  }

  get size(): number {
    return this.entries.length;
  }

  // Background sweep: re-probe every parked server and either un-park it (model
  // ready again) or push its cooldown forward, so a dead server stays parked
  // without wasting real requests while a recovered one rejoins promptly.
  private async reprobe(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const now = Date.now();
      const parked = this.entries.filter(e => e.downUntil > now);
      await Promise.all(parked.map(async e => {
        const ok = await ensureModelLoaded(e.server, this.modelId);
        e.downUntil = ok ? 0 : Date.now() + TTS_SERVER_COOLDOWN_MS;
        if (ok) this.wake();
      }));
    } finally {
      this.probing = false;
    }
  }

  // Stop the background re-probe. Call once the run that owns this pool is done.
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  // Reserve the least-loaded server that's healthy now, under its concurrency
  // cap, and not already tried for this request. Returns null when every
  // candidate is at capacity, tried, or parked.
  private take(exclude: Set<string>, now: number): PoolEntry | null {
    const free = this.entries
      .filter(e => e.downUntil <= now && !exclude.has(e.server.id) && e.inFlight < TTS_SERVER_CONCURRENCY)
      .sort((a, b) => a.inFlight - b.inFlight);
    if (free.length === 0) return null;
    free[0].inFlight++;
    return free[0];
  }

  // Whether an untried, healthy server exists that's merely at capacity — i.e.
  // waiting for a slot to free is worthwhile (as opposed to everything being
  // tried or parked).
  private atCapacity(exclude: Set<string>, now: number): boolean {
    return this.entries.some(e =>
      e.downUntil <= now && !exclude.has(e.server.id) && e.inFlight >= TTS_SERVER_CONCURRENCY);
  }

  private waitForSlot(): Promise<void> {
    return new Promise(resolve => this.waiters.push(resolve));
  }

  // Wake every waiter to re-run take(); losers just queue up again.
  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
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
  // When every healthy server is at its concurrency cap, wait for a slot instead
  // of over-committing to one — the next segment always lands on whichever server
  // frees up first, so a fast server pulls proportionally more work. Each failing
  // server is parked so concurrent and later calls skip it. Throws the last error
  // only when no server can complete the request.
  async run<T>(fn: (server: TtsServer) => Promise<T>): Promise<T> {
    const tried = new Set<string>();
    let lastErr: unknown;
    for (;;) {
      const now = Date.now();
      const entry = this.take(tried, now);
      if (!entry) {
        if (this.atCapacity(tried, now)) {
          await this.waitForSlot();
          continue;
        }
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
        this.wake();
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
