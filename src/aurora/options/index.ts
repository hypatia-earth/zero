/**
 * AuroraOptions — aurora's canonical option store.
 *
 * Owns aurora-db end-to-end (engine + per-layer options blob) and the
 * in-memory snapshot the worker reads each frame. Persistence is a method
 * on the noun, not a separate module.
 *
 * Lifecycle (worker scope):
 *   const options = new AuroraOptions({ dbName: 'aurora-db' });
 *   await options.init({ engine: { timeslotsPerLayer: cfg.timeslotsPerLayer }, ... });
 *   options.read();                 // sync snapshot for renders
 *   options.updateEngine(patch);    // sync mutate, debounced internal save
 *   options.updateLayer(id, patch); // sync mutate, debounced internal save
 *   await options.clear();          // wipe (e.g. user clicks Nuke)
 *   await options.flush();          // before cleanup
 *
 * Concurrency: every IDB op (put/delete) goes through `opQueue`, so debounced
 * saves and explicit clears commit in FIFO order even if their JS Promises
 * settle out of order. In-memory mutations (`update*`, `clear`) run sync
 * before any await, so JS run-to-completion preserves message-order semantics
 * across the worker's async dispatch loop.
 */

import type { AuroraOptions as AuroraOptionsBlob, EngineOpts, LayerEntry } from '../types/options';
import {
  openAuroraDb,
  getFromStore,
  putInStore,
  deleteFromStore,
  OPTIONS_STORE,
  CACHE_STORE,
  OPTIONS_KEY,
} from './aurora-db';
import { migrate, CURRENT_SCHEMA_VERSION, type PersistedOptions } from './migrations';

const DEFAULT_DEBOUNCE_MS = 300;

/**
 * Aurora-side defaults. Engine fields here are placeholders — the host's
 * init seeds (timeslotsPerLayer, useTimestampQueries) overwrite them. Layer
 * entries start empty; each typed-setter populates `layers[id]` lazily.
 */
export const AURORA_OPTIONS_DEFAULTS: AuroraOptionsBlob = {
  engine: {
    timeslotsPerLayer: 0,
    useTimestampQueries: false,
  },
  layers: {},
};

export interface AuroraOptionsConfig {
  dbName: string;
  /** Debounce window for internal saves (default 300ms). */
  saveDebounceMs?: number;
  /** Per-instance default blob, layered below persisted+seeds. Lets the
   *  caller supply pre-dispatch fallbacks aurora itself can't know (e.g.
   *  host-shape layer opts that arrive shortly via setter dispatch). */
  defaults?: AuroraOptionsBlob;
}

/**
 * Per-init seeds — values the host insists on for *this run* (e.g. capacity
 * config). Merged on top of any persisted blob, so seeds beat IDB. Layer
 * seeds shallow-merge into existing layer entries.
 */
export interface AuroraOptionsInitSeeds {
  engine?: Partial<EngineOpts>;
  layers?: Record<string, { opacity?: number; opts?: Record<string, unknown> }>;
}

export class AuroraOptions {
  private dbName: string;
  private saveDebounceMs: number;
  private dbPromise: Promise<IDBDatabase> | null = null;

  /** Per-instance defaults — restored on `clear()`, layered below persisted/seeds. */
  private readonly defaults: AuroraOptionsBlob;

  /** Canonical in-memory blob. Replaced atomically by every mutation. */
  private data: AuroraOptionsBlob;

  /** Serializes IDB ops (put/delete) so durable order matches enqueue order. */
  private opQueue: Promise<unknown> = Promise.resolve();

  private pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSaveBlob: PersistedOptions | null = null;

  constructor(config: AuroraOptionsConfig) {
    this.dbName = config.dbName;
    this.saveDebounceMs = config.saveDebounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.defaults = structuredClone(config.defaults ?? AURORA_OPTIONS_DEFAULTS);
    this.data = structuredClone(this.defaults);
  }

  /**
   * Open IDB, load persisted blob (if any), apply migrations, merge with
   * defaults and per-init seeds. Merge precedence: defaults < persisted < seeds.
   * Must be awaited before any `read`/`update*` call.
   */
  async init(seeds: AuroraOptionsInitSeeds): Promise<void> {
    const db = await this.openDb();
    const stored = await getFromStore<PersistedOptions>(db, OPTIONS_STORE, OPTIONS_KEY);
    const persisted: AuroraOptionsBlob | null = stored ? migrate(stored).options : null;

    // Merge precedence: defaults < persisted < seeds.
    const engine: EngineOpts = {
      ...this.defaults.engine,
      ...persisted?.engine,
      ...seeds.engine,
    };

    const layers: Record<string, LayerEntry> = {};
    const mergeOpts = (a: unknown, b: unknown): unknown => {
      if (b === undefined) return a;
      if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
        return { ...a as Record<string, unknown>, ...b as Record<string, unknown> };
      }
      return b;
    };
    const ids = new Set<string>([
      ...Object.keys(this.defaults.layers),
      ...Object.keys(persisted?.layers ?? {}),
      ...Object.keys(seeds.layers ?? {}),
    ]);
    for (const id of ids) {
      const def = this.defaults.layers[id];
      const per = persisted?.layers[id];
      const seed = seeds.layers?.[id];
      const opacity = seed?.opacity ?? per?.opacity ?? def?.opacity ?? 0;
      const opts = mergeOpts(mergeOpts(def?.opts, per?.opts), seed?.opts);
      layers[id] = { opacity, opts: opts ?? {} };
    }

    this.data = { engine, layers };
  }

  /** Sync snapshot of the current options blob. */
  read(): AuroraOptionsBlob {
    return this.data;
  }

  /** Patch engine fields (shallow-merge). Sync; schedules debounced persist. */
  updateEngine(patch: Partial<EngineOpts>): void {
    this.data = { ...this.data, engine: { ...this.data.engine, ...patch } };
    this.scheduleSave();
  }

  /**
   * Patch a layer entry (opacity and/or opts). `opts` shallow-merges into
   * the existing layer's opts. Sync; schedules debounced persist.
   */
  updateLayer(id: string, patch: { opacity?: number; opts?: Record<string, unknown> }): void {
    const prev = this.data.layers[id];
    const prevOpts = (prev?.opts ?? {}) as Record<string, unknown>;
    const next: LayerEntry = {
      opacity: patch.opacity !== undefined ? patch.opacity : (prev?.opacity ?? 0),
      opts: patch.opts !== undefined ? { ...prevOpts, ...patch.opts } : (prev?.opts ?? {}),
    };
    this.data = { ...this.data, layers: { ...this.data.layers, [id]: next } };
    this.scheduleSave();
  }

  /**
   * Reset in-memory to defaults synchronously, cancel any pending save,
   * then enqueue an IDB delete. Awaitable for callers that need ack
   * (Nuke flow doesn't need to — message FIFO + sync reset is enough).
   */
  async clear(): Promise<void> {
    this.data = structuredClone(this.defaults);
    this.cancelPendingSave();
    await this.enqueue(async () => {
      const db = await this.openDb();
      await deleteFromStore(db, OPTIONS_STORE, OPTIONS_KEY);
    });
  }

  /** Force-write any pending debounced save and drain the op queue. */
  async flush(): Promise<void> {
    if (this.pendingSaveTimer) {
      clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = null;
      const blob = this.pendingSaveBlob;
      this.pendingSaveBlob = null;
      if (blob) {
        this.enqueue(async () => {
          const db = await this.openDb();
          await putInStore(db, OPTIONS_STORE, OPTIONS_KEY, blob);
        });
      }
    }
    await this.opQueue;
  }

  // ─── Cache passthrough (shader/capability caches, unchanged from persistence) ─

  async loadCache<T>(key: string): Promise<T | null> {
    const db = await this.openDb();
    return getFromStore<T>(db, CACHE_STORE, key);
  }

  async saveCache<T>(key: string, value: T): Promise<void> {
    const db = await this.openDb();
    await putInStore(db, CACHE_STORE, key, value);
  }

  async deleteCache(key: string): Promise<void> {
    const db = await this.openDb();
    await deleteFromStore(db, CACHE_STORE, key);
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openAuroraDb(this.dbName);
    }
    return this.dbPromise;
  }

  private scheduleSave(): void {
    this.pendingSaveBlob = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      options: this.data,
      lastModified: new Date().toISOString(),
    };
    if (this.pendingSaveTimer) clearTimeout(this.pendingSaveTimer);
    this.pendingSaveTimer = setTimeout(() => {
      const blob = this.pendingSaveBlob;
      this.pendingSaveTimer = null;
      this.pendingSaveBlob = null;
      if (!blob) return;
      this.enqueue(async () => {
        const db = await this.openDb();
        await putInStore(db, OPTIONS_STORE, OPTIONS_KEY, blob);
      });
    }, this.saveDebounceMs);
  }

  private cancelPendingSave(): void {
    if (this.pendingSaveTimer) {
      clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = null;
    }
    this.pendingSaveBlob = null;
  }

  /** Enqueue an IDB op so durable order = enqueue order. Errors don't poison. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(fn, fn);
    this.opQueue = next.catch(() => undefined);
    return next;
  }
}
