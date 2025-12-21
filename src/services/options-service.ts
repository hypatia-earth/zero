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
  type ZeroOptions,
  type OptionFilter,
} from '../schemas/options.schema';
import { deepMerge, getByPath, setByPath } from '../utils/object';
import { layerIds } from '../config/defaults';
import type { TLayer } from '../config/types';
import type { ConfigService } from './config-service';
import { throttle } from '../utils/debounce';

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

  /** Dialog state */
  dialogOpen = false;
  dialogFilter: OptionFilter | undefined = undefined;

  /** First time user detection */
  isFirstTimeUser = false;
  usageStats: UsageStats | null = null;

  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private urlSyncEnabled = false;
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
      if (this.saveTimeout) clearTimeout(this.saveTimeout);
      this.saveTimeout = setTimeout(() => this.save(), 500);
    });

    // Auto-sync to URL when options change (throttled, last value guaranteed)
    const throttledUrlSync = throttle(() => {
      if (this.urlSyncEnabled) {
        this.syncToUrl(this.options.value);  // read fresh value
      }
    }, 100);

    effect(() => {
      this.options.value;  // subscribe to changes
      throttledUrlSync();
    });

    // Force save before page unload
    window.addEventListener('beforeunload', () => {
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.save();
      }
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
  }

  /**
   * Sanitize time after timestep discovery - snap to closest available timestep
   * Call from app.ts after TimestepService.initialize()
   */
  sanitize(getClosestTimestep: (time: Date) => Date): void {
    const params = new URLSearchParams(window.location.search);
    const changes: string[] = [];
    const vs = this.options.value.viewState;

    // Snap time to closest available timestep
    const snappedTime = getClosestTimestep(vs.time);
    if (snappedTime.getTime() !== vs.time.getTime()) {
      this.update(o => { o.viewState.time = snappedTime; });
      changes.push(`time=${vs.time.toISOString().slice(0, 13)}→${snappedTime.toISOString().slice(0, 13)}`);
    }

    // Lat/lon: log if defaulted or clamped
    // URL uses 1 decimal (toFixed(1)) ≈ 11km precision, matching ECMWF 0.1° grid (~10km)
    // Integer scaling avoids IEEE 754 false positives in comparison
    const llParam = params.get('ll');
    if (!llParam) {
      changes.push(`lat=${vs.lat.toFixed(1)}`, `lon=${vs.lon.toFixed(1)}`);
    } else {
      const parts = llParam.split(',').map(parseFloat);
      const rawLat = parts[0] ?? NaN;
      const rawLon = parts[1] ?? NaN;
      if (Math.round(rawLat * 10) !== Math.round(vs.lat * 10)) changes.push(`lat=${rawLat}→${vs.lat}`);
      if (Math.round(rawLon * 10) !== Math.round(vs.lon * 10)) changes.push(`lon=${rawLon}→${vs.lon}`);
    }

    // Altitude: log if defaulted or clamped
    const altParam = params.get('alt');
    if (!altParam) {
      changes.push(`alt=${vs.altitude}`);
    } else {
      const rawAlt = parseFloat(altParam);
      if (rawAlt !== vs.altitude) changes.push(`alt=${rawAlt}→${vs.altitude}`);
    }

    if (changes.length) console.log(`[Sanitized] ${changes.join(', ')}`);

    // Write sanitized state to URL
    this.syncToUrl(this.options.value);
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

  // ----------------------------------------------------------
  // URL synchronization
  // ----------------------------------------------------------

  /**
   * Enable URL synchronization (call after initial load)
   * Immediately syncs current state to URL
   */
  enableUrlSync(): void {
    this.urlSyncEnabled = true;
    this.syncToUrl(this.options.value);  // Write sanitized state to URL
  }

  /**
   * Read options from URL query parameters
   * Full sanitize (defaults) only when URL has NO params at all
   * Any params = explicit state, respect exactly what's given
   */
  private readUrlOptions(): Partial<ZeroOptions> {
    const params = new URLSearchParams(window.location.search);
    const overrides: Record<string, unknown> = {};

    // Parse viewState from URL
    const viewState: Record<string, unknown> = {};

    const dt = params.get('dt');
    if (dt) {
      const time = this.parseDateFromUrl(dt);
      if (time) viewState.time = time;
    }

    const ll = params.get('ll');
    if (ll) {
      const [latStr, lonStr] = ll.split(',');
      const lat = parseFloat(latStr ?? '');
      const lon = parseFloat(lonStr ?? '');
      if (!isNaN(lat) && !isNaN(lon)) {
        viewState.lat = Math.max(-90, Math.min(90, lat));
        viewState.lon = ((lon + 180) % 360) - 180;
      }
    }

    const alt = params.get('alt');
    if (alt) {
      const altitude = parseFloat(alt);
      if (!isNaN(altitude)) {
        viewState.altitude = Math.max(300, Math.min(36_000, altitude));
      }
    }

    if (Object.keys(viewState).length > 0) {
      overrides.viewState = viewState;
    }

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

  private parseDateFromUrl(dt: string): Date | null {
    const normalized = dt.replace('h', ':').replace('z', ':00.000Z');
    const date = new Date(normalized);
    return isNaN(date.getTime()) ? null : date;
  }

  private formatDateForUrl(date: Date): string {
    return date.toISOString().slice(0, 16).replace(':', 'h') + 'z';
  }

  /**
   * Sync persist:'url' options to URL query parameters
   * Builds URL manually to keep commas unencoded
   */
  private syncToUrl(options: ZeroOptions): void {
    const { viewState } = options;

    // Build viewState params
    const dt = this.formatDateForUrl(viewState.time);
    const ll = `${viewState.lat.toFixed(1)},${viewState.lon.toFixed(1)}`;
    const alt = Math.round(viewState.altitude).toString();

    // Build layers param
    const enabledLayers = layerIds.filter(id => options[id].enabled);

    // Build URL manually to keep commas unencoded
    let search = `?dt=${dt}&ll=${ll}&alt=${alt}`;
    if (enabledLayers.length > 0) {
      search += '&layers=' + enabledLayers.join(',');
    }

    window.history.replaceState(null, '', search);
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
    this.dialogOpen = false;
    this.dialogFilter = undefined;
    m.redraw();
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
