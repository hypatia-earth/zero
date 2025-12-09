/**
 * OptionsService - Reactive user options with IndexedDB persistence
 */

import { signal, effect } from '@preact/signals-core';
import { produce } from 'immer';
import { optionsSchema, defaultOptions, type ZeroOptions } from '../schemas/options.schema';

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

async function loadFromDB(): Promise<Partial<ZeroOptions> | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(OPTIONS_KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result?.options ?? null);
      tx.oncomplete = () => db.close();
    });
  } catch (err) {
    console.warn('[Options] IndexedDB load error:', err);
    return null;
  }
}

async function saveToDB(options: Partial<ZeroOptions>): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ options, _lastModified: new Date().toISOString() }, OPTIONS_KEY);
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
// OptionsService
// ============================================================

export class OptionsService {
  private userOverrides = signal<Partial<ZeroOptions>>({});
  readonly options = signal<ZeroOptions>(defaultOptions);
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
  }

  async load(): Promise<void> {
    const stored = await loadFromDB();
    if (stored) {
      const result = optionsSchema.partial().safeParse(stored);
      if (result.success) {
        // Filter out undefined values from Zod partial parse
        this.userOverrides.value = JSON.parse(JSON.stringify(result.data)) as Partial<ZeroOptions>;
        console.log('[Options] Loaded from IndexedDB');
      }
    }
    this.initialized = true;
  }

  update(fn: (draft: ZeroOptions) => void): void {
    const updated = produce(this.options.value, fn);
    this.userOverrides.value = this.extractOverrides(updated);
  }

  reset(): void {
    this.userOverrides.value = {};
  }

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
          if (Object.keys(nested).length > 0) target[key] = nested;
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
}

export type { ZeroOptions };
