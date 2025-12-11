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

const DB_NAME = 'hypatia-zero';
const DB_VERSION = 1;
const STORE_NAME = 'options';
const OPTIONS_KEY = 'user-options';

// ============================================================
// IndexedDB helpers
// ============================================================

async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

async function loadFromDB(): Promise<{ options: Partial<ZeroOptions> | null; isNewDB: boolean }> {
  try {
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
      };
    });

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
    const db = await openDB();
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

// ============================================================
// Deep merge utility
// ============================================================

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = target[key];
    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue as object, sourceValue as object) as T[keyof T];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }
  return result;
}

// ============================================================
// Path utilities
// ============================================================

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

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

  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  constructor() {
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
    if (navigator.storage?.persist) {
      const granted = await navigator.storage.persist();
      console.log(`[Options] Persistent storage: ${granted ? 'granted' : 'denied'}`);
    }

    const { options: stored, isNewDB } = await loadFromDB();

    if (isNewDB) {
      console.log('[Options] IndexedDB initialized');
    }

    if (stored) {
      const result = optionsSchema.partial().safeParse(stored);
      if (result.success) {
        this.userOverrides.value = this.extractOverrides(
          deepMerge(defaultOptions, result.data as Partial<ZeroOptions>)
        );
        const count = Object.keys(this.userOverrides.value).length;
        console.log(`[Options] Loaded ${count} override(s)`);
      }
    } else {
      console.log('[Options] No stored options, using defaults');
    }

    this.initialized = true;
  }

  /**
   * Update options using Immer-style mutation
   */
  update(fn: (draft: ZeroOptions) => void): void {
    const oldOverrides = this.userOverrides.value;
    const updated = produce(this.options.value, fn);
    const newOverrides = this.extractOverrides(updated);

    // Log what changed
    const oldKeys = this.flattenKeys(oldOverrides);
    const newKeys = this.flattenKeys(newOverrides);
    const changedKey = newKeys.find(k => !oldKeys.includes(k) || getByPath(oldOverrides, k) !== getByPath(newOverrides, k))
      || oldKeys.find(k => !newKeys.includes(k));

    if (changedKey) {
      const newValue = getByPath(newOverrides, changedKey);
      if (newValue !== undefined) {
        console.log(`[Options] ${changedKey} = ${JSON.stringify(newValue)}`);
      } else {
        console.log(`[Options] ${changedKey} reset to default`);
      }
    }

    this.userOverrides.value = newOverrides;
  }

  /**
   * Reset option(s) to default
   * @param path - Dot-path to reset (e.g., 'wind.opacity'), or undefined for all
   */
  reset(path?: string): void {
    if (!path) {
      console.log('[Options] Reset all to defaults');
      this.userOverrides.value = {};
      return;
    }

    console.log(`[Options] Reset ${path} to default`);
    this.userOverrides.value = deleteByPath(this.userOverrides.value, path);
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

        if (typeof curVal === 'object' && curVal !== null && !Array.isArray(curVal)) {
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
