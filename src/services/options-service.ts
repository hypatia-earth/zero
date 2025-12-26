/**
 * OptionsService - Reactive user options with IndexedDB persistence
 *
 * Features:
 * - Preact signals for reactivity
 * - Immer for immutable updates
 * - IndexedDB persistence (override-only storage)
 * - Dialog state management with filtering
 * - Path-based reset
 */

import { signal, effect } from '@preact/signals-core';
import { produce } from 'immer';
import m from 'mithril';
import {
  optionsSchema,
  defaultOptions,
  extractOptionsMeta,
  type ZeroOptions,
  type OptionFilter,
} from '../schemas/options.schema';
import { deepMerge, getByPath, setByPath } from '../utils/object';
import { debounceFlush } from '../utils/debounce-flush';
import { layerIds } from '../config/defaults';
import type { TLayer } from '../config/types';
import type { ConfigService } from './config-service';
import { updatePrefetchConfig } from './sw-registration';

const DEBUG = false;

const DB_NAME = 'hypatia-zero';
const DB_VERSION = 3;
const STORE_NAME = 'options';
const OPTIONS_KEY = 'user-options';
const USAGE_STORE = 'usage';
const USAGE_KEY = 'stats';

interface UsageStats {
  visits: number;
  firstVisit: string;  // ISO date
  lastVisit: string;   // ISO date
}

// ============================================================
// IndexedDB helpers
// ============================================================

async function openDB(): Promise<{ db: IDBDatabase; isNewDB: boolean }> {
  let isNewDB = false;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      isNewDB = true;
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(USAGE_STORE)) {
        db.createObjectStore(USAGE_STORE);
      }
    };
  });
  return { db, isNewDB };
}

async function loadFromDB(): Promise<{ options: Partial<ZeroOptions> | null; isNewDB: boolean }> {
  try {
    const { db, isNewDB } = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(OPTIONS_KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve({
        options: request.result?.options ?? null,
        isNewDB
      });
      tx.oncomplete = () => db.close();
    });
  } catch (err) {
    console.warn('[Options] IndexedDB load error:', err);
    return { options: null, isNewDB: false };
  }
}

async function saveToDB(options: Partial<ZeroOptions>): Promise<void> {
  try {
    const { db } = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({
        _version: defaultOptions._version,
        _lastModified: new Date().toISOString(),
        options
      }, OPTIONS_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[Options] IndexedDB save error:', err);
  }
}

async function loadUsageStats(): Promise<UsageStats | null> {
  try {
    const { db } = await openDB();
    // Guard for migration: store might not exist yet
    if (!db.objectStoreNames.contains(USAGE_STORE)) {
      db.close();
      return null;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(USAGE_STORE, 'readonly');
      const store = tx.objectStore(USAGE_STORE);
      const request = store.get(USAGE_KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
      tx.oncomplete = () => db.close();
    });
  } catch (err) {
    console.warn('[Options] Usage stats load error:', err);
    return null;
  }
}

async function saveUsageStats(stats: UsageStats): Promise<void> {
  try {
    const { db } = await openDB();
    // Guard for migration: store might not exist yet
    if (!db.objectStoreNames.contains(USAGE_STORE)) {
      db.close();
      return;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(USAGE_STORE, 'readwrite');
      const store = tx.objectStore(USAGE_STORE);
      store.put(stats, USAGE_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[Options] Usage stats save error:', err);
  }
}

// ============================================================
// Path utilities
// ============================================================

function deleteByPath<T extends object>(obj: T, path: string): T {
  return produce(obj, (draft) => {
    const keys = path.split('.');
    const last = keys.pop()!;
    let current: unknown = draft;

    for (const key of keys) {
      current = (current as Record<string, unknown>)[key];
      if (current === undefined) return;
    }

    delete (current as Record<string, unknown>)[last];
  });
}

// ============================================================
// OptionsService
// ============================================================

export type { TLayer };

export class OptionsService {
  /** User overrides only (persisted to IndexedDB) */
  private userOverrides = signal<Partial<ZeroOptions>>({});

  /** Merged options: defaults + user overrides */
  readonly options = signal<ZeroOptions>(defaultOptions);

  /** Layers currently loading (e.g., after resolution switch) */
  readonly loadingLayers = signal<Set<string>>(new Set());

  /** Options with impact='recreate' have changed - needs page reload */
  readonly needsReload = signal(false);

  /** Initial values of recreate-impact options (captured at init) */
  private recreateInitialValues: Record<string, unknown> = {};

  /** Dialog state */
  dialogOpen = false;
  dialogClosing = false;
  dialogFilter: OptionFilter | undefined = undefined;

  /** First time user detection */
  isFirstTimeUser = false;
  usageStats: UsageStats | null = null;

  private debouncedSave = debounceFlush(() => this.save(), 500);
  private initialized = false;

  constructor(private configService: ConfigService) {
    // Auto-merge when userOverrides change
    effect(() => {
      this.options.value = deepMerge(defaultOptions, this.userOverrides.value);
    });

    // Auto-save on change (debounced)
    effect(() => {
      void this.userOverrides.value;
      if (!this.initialized) return;
      this.debouncedSave();
    });

    // Force save before page unload
    window.addEventListener('beforeunload', () => this.debouncedSave.flush());

    // Save when page becomes hidden (more reliable in Safari)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.debouncedSave.flush();
    });

    // Sync prefetch config to SW when prefetch options change
    effect(() => {
      const { prefetch } = this.options.value;
      if (!this.initialized) return;

      const layers: string[] = [];
      if (prefetch.temp) layers.push('temp');
      if (prefetch.pressure) layers.push('pressure');
      if (prefetch.wind) layers.push('wind');

      void updatePrefetchConfig({
        enabled: prefetch.enabled,
        forecastDays: prefetch.forecastDays,
        layers,
      });
    });
  }

  /**
   * Load user options from IndexedDB
   * Call once at app startup
   */
  async load(): Promise<void> {
    // Request persistent storage
    let storageGranted = false;
    if (navigator.storage?.persist) {
      storageGranted = await navigator.storage.persist();
    }

    const { options: stored } = await loadFromDB();

    // Track usage stats
    const now = new Date().toISOString();
    const existingStats = await loadUsageStats();
    if (existingStats) {
      this.usageStats = {
        visits: existingStats.visits + 1,
        firstVisit: existingStats.firstVisit,
        lastVisit: now,
      };
      this.isFirstTimeUser = false;
    } else {
      this.usageStats = { visits: 1, firstVisit: now, lastVisit: now };
      this.isFirstTimeUser = true;
    }
    await saveUsageStats(this.usageStats);

    // Merge: defaults < IndexedDB < URL
    let merged = defaultOptions;
    let overrideCount = 0;

    if (stored) {
      const result = optionsSchema.partial().safeParse(stored);
      if (result.success) {
        merged = deepMerge(merged, result.data as Partial<ZeroOptions>);
        overrideCount = Object.keys(result.data).length;
      }
    }

    // Single log line
    const idb = storageGranted ? 'granted' : 'denied';
    console.log(`[Options] IDB ${idb}, V #${this.usageStats.visits}, ${overrideCount} Overrides`);

    // Apply URL overrides (takes precedence)
    const urlOverrides = this.readUrlOptions();
    if (Object.keys(urlOverrides).length > 0) {
      merged = deepMerge(merged, urlOverrides);
    }

    this.userOverrides.value = this.extractOverrides(merged);
    this.initialized = true;

    // Capture initial values of recreate-impact options
    this.captureRecreateInitialValues();
  }

  /** Capture initial values of options with impact='recreate' */
  private captureRecreateInitialValues(): void {
    const meta = extractOptionsMeta();
    for (const opt of meta) {
      if (opt.meta.impact === 'recreate') {
        this.recreateInitialValues[opt.path] = getByPath(this.options.value, opt.path);
      }
    }
  }

  /** Check if any recreate-impact option has changed from initial value */
  private checkNeedsReload(): void {
    for (const [path, initialValue] of Object.entries(this.recreateInitialValues)) {
      const currentValue = getByPath(this.options.value, path);
      if (currentValue !== initialValue) {
        this.needsReload.value = true;
        return;
      }
    }
    this.needsReload.value = false;
  }


  /**
   * Update options using Immer-style mutation
   */
  update(fn: (draft: ZeroOptions) => void): void {
    const oldOverrides = this.userOverrides.value;
    const updated = produce(this.options.value, fn);
    const newOverrides = this.extractOverrides(updated);
    this.logChange(oldOverrides, newOverrides);
    this.userOverrides.value = newOverrides;
    this.checkNeedsReload();
  }

  /**
   * Set enabled layers from StateService (URL delegation)
   */
  setEnabledLayers(enabledSet: Set<string>): void {
    for (const layerId of layerIds) {
      const shouldEnable = enabledSet.has(layerId);
      const current = this.options.value[layerId as keyof ZeroOptions] as { enabled: boolean };
      if (current.enabled !== shouldEnable) {
        this.update(d => {
          (d[layerId as keyof ZeroOptions] as { enabled: boolean }).enabled = shouldEnable;
        });
      }
    }
  }

  /**
   * Get list of enabled layer IDs for URL sync
   */
  getEnabledLayers(): string[] {
    return layerIds.filter(id => {
      const layer = this.options.value[id as keyof ZeroOptions] as { enabled?: boolean };
      return layer?.enabled === true;
    });
  }

  private logChange(oldOverrides: Partial<ZeroOptions>, newOverrides: Partial<ZeroOptions>): void {
    const oldKeys = this.flattenKeys(oldOverrides);
    const newKeys = this.flattenKeys(newOverrides);
    const changedKey = newKeys.find(k => !oldKeys.includes(k) || getByPath(oldOverrides, k) !== getByPath(newOverrides, k))
      || oldKeys.find(k => !newKeys.includes(k));
    if (!changedKey) return;

    const newValue = getByPath(newOverrides, changedKey);
    DEBUG && console.log(newValue !== undefined
      ? `[Options] ${changedKey} = ${JSON.stringify(newValue)}`
      : `[Options] ${changedKey} reset to default`);
  }

  /**
   * Reset option(s) to default
   * @param path - Dot-path to reset (e.g., 'wind.opacity'), or undefined for all
   */
  reset(path?: string): void {
    if (!path) {
      DEBUG && console.log('[Options] Reset all to defaults');
      this.userOverrides.value = {};
      return;
    }

    DEBUG && console.log(`[Options] Reset ${path} to default`);
    this.userOverrides.value = deleteByPath(this.userOverrides.value, path);
  }

  /**
   * Revert option to a previous value (e.g., after failed operation)
   * Goes through proper update flow for persistence
   */
  revertOption(path: string, value: unknown): void {
    console.log(`[Options] Revert ${path} = ${value}`);
    this.update(draft => {
      setByPath(draft, path, value);
    });
  }

  /**
   * Check if a specific option has been changed from default
   */
  isModified(path: string): boolean {
    return getByPath(this.userOverrides.value, path) !== undefined;
  }

  /**
   * Set loading state for a layer (e.g., during resolution switch)
   */
  setLayerLoading(layerId: string, loading: boolean): void {
    const current = this.loadingLayers.value;
    const newSet = new Set(current);
    if (loading) {
      newSet.add(layerId);
    } else {
      newSet.delete(layerId);
    }
    this.loadingLayers.value = newSet;
    m.redraw();
  }

  /**
   * Check if a layer is currently loading
   */
  isLayerLoading(layerId: string): boolean {
    return this.loadingLayers.value.has(layerId);
  }

  /**
   * Get user overrides (for debugging/export)
   */
  getOverrides(): Partial<ZeroOptions> {
    return this.userOverrides.value;
  }

  /**
   * Read layer enables from URL (called during init before StateService delegates)
   * Note: StateService owns URL, but OptionsService needs initial layer state
   */
  private readUrlOptions(): Partial<ZeroOptions> {
    const params = new URLSearchParams(window.location.search);
    const overrides: Record<string, unknown> = {};

    // Parse layers from URL, fall back to config defaults
    const layersStr = params.get('layers');
    const enabledLayers = layersStr !== null
      ? new Set(layersStr.split(',').filter(l => l.length > 0))
      : new Set(this.configService.getDefaultLayers());

    for (const layerId of layerIds) {
      if (!overrides[layerId]) {
        overrides[layerId] = {};
      }
      (overrides[layerId] as Record<string, unknown>).enabled = enabledLayers.has(layerId);
    }

    return overrides as Partial<ZeroOptions>;
  }

  // ----------------------------------------------------------
  // Dialog management
  // ----------------------------------------------------------

  /**
   * Open options dialog
   * @param filter - Optional filter to show only specific options
   */
  openDialog(filter?: OptionFilter): void {
    this.dialogOpen = true;
    this.dialogFilter = filter;
    m.redraw();
  }

  closeDialog(): void {
    this.dialogClosing = true;
    m.redraw();
    setTimeout(() => {
      this.dialogOpen = false;
      this.dialogClosing = false;
      this.dialogFilter = undefined;
      m.redraw();
    }, 250);
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private extractOverrides(options: ZeroOptions): Partial<ZeroOptions> {
    const overrides: Record<string, unknown> = {};

    const extract = (defaults: unknown, current: unknown, target: Record<string, unknown>) => {
      if (typeof defaults !== 'object' || defaults === null) return;
      if (typeof current !== 'object' || current === null) return;

      for (const key of Object.keys(current as object)) {
        const defVal = (defaults as Record<string, unknown>)[key];
        const curVal = (current as Record<string, unknown>)[key];

        // Handle Date specially (typeof Date === 'object' but has no enumerable keys)
        if (curVal instanceof Date) {
          if (!(defVal instanceof Date) || curVal.getTime() !== defVal.getTime()) {
            target[key] = curVal;
          }
        } else if (typeof curVal === 'object' && curVal !== null && !Array.isArray(curVal)) {
          const nested: Record<string, unknown> = {};
          extract(defVal, curVal, nested);
          if (Object.keys(nested).length > 0) {
            target[key] = nested;
          }
        } else if (curVal !== defVal) {
          target[key] = curVal;
        }
      }
    };

    extract(defaultOptions, options, overrides);
    return overrides as Partial<ZeroOptions>;
  }

  private async save(): Promise<void> {
    await saveToDB(this.userOverrides.value);
  }

  private flattenKeys(obj: unknown, prefix = ''): string[] {
    const keys: string[] = [];
    if (typeof obj !== 'object' || obj === null) return keys;
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        keys.push(...this.flattenKeys(value, path));
      } else {
        keys.push(path);
      }
    }
    return keys;
  }
}

export type { ZeroOptions };
