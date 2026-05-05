/**
 * AuroraPersistence — aurora-side IDB persistence module.
 *
 * Sub-B Phase 4 deliverable. Phase 5 wires this into the worker:
 *   - `loadOptions()` runs at init; result merges with `initialOptions`.
 *   - `saveOptions(opts)` runs (debounced) on every typed-setter mutation.
 *
 * Two responsibilities:
 *   1. Persist the merged AuroraOptions blob with schema versioning.
 *   2. Provide a generic key/value cache store for shader/capability caches.
 *
 * Aurora autarky: this module imports only from `./aurora-db`, `./migrations/`
 * and `../types/`. No host imports.
 */

import type { AuroraOptions } from '../types/options';
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

export interface AuroraPersistenceConfig {
  dbName: string;
  /** Debounce window for `saveOptions` (default 300ms). */
  saveDebounceMs?: number;
}

export class AuroraPersistence {
  private dbName: string;
  private saveDebounceMs: number;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSaveBlob: PersistedOptions | null = null;

  constructor(config: AuroraPersistenceConfig) {
    this.dbName = config.dbName;
    this.saveDebounceMs = config.saveDebounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Read AuroraOptions from aurora-db. Returns null on first run (no entry).
   * Throws if the stored schemaVersion is newer than this build understands.
   */
  async loadOptions(): Promise<AuroraOptions | null> {
    const db = await this.openDb();
    const blob = await getFromStore<PersistedOptions>(db, OPTIONS_STORE, OPTIONS_KEY);
    if (!blob) return null;
    const migrated = migrate(blob);
    return migrated.options;
  }

  /**
   * Write AuroraOptions, debounced. Coalesces rapid calls (e.g. slider drags)
   * into a single IDB write. Use `flushSave()` before unload to force a write.
   */
  saveOptions(options: AuroraOptions): void {
    this.pendingSaveBlob = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      options,
      lastModified: new Date().toISOString(),
    };
    if (this.pendingSaveTimer) clearTimeout(this.pendingSaveTimer);
    this.pendingSaveTimer = setTimeout(() => { void this.flushSave(); }, this.saveDebounceMs);
  }

  /** Force-write any pending debounced save. Safe to call when nothing is pending. */
  async flushSave(): Promise<void> {
    if (this.pendingSaveTimer) {
      clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = null;
    }
    const blob = this.pendingSaveBlob;
    if (!blob) return;
    this.pendingSaveBlob = null;
    const db = await this.openDb();
    await putInStore(db, OPTIONS_STORE, OPTIONS_KEY, blob);
  }

  /** Cache: read a value by key. Returns null when absent. */
  async loadCache<T>(key: string): Promise<T | null> {
    const db = await this.openDb();
    return getFromStore<T>(db, CACHE_STORE, key);
  }

  /** Cache: write a value by key. */
  async saveCache<T>(key: string, value: T): Promise<void> {
    const db = await this.openDb();
    await putInStore(db, CACHE_STORE, key, value);
  }

  /** Cache: delete a value by key. */
  async deleteCache(key: string): Promise<void> {
    const db = await this.openDb();
    await deleteFromStore(db, CACHE_STORE, key);
  }

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openAuroraDb(this.dbName);
    }
    return this.dbPromise;
  }
}
