/**
 * LayerService - Dynamic registry of all layers (built-in and user)
 *
 * Single source of truth for layer configuration. Both V1 and V2
 * workers query this registry to determine which layers exist
 * and their configurations.
 *
 * User layers are persisted to IndexedDB.
 */

import { signal, type Signal, type ReadonlySignal } from '@preact/signals-core';
import { BUILT_IN_LAYERS, CUSTOM_LAYERS, type TBuiltInLayer, type TCustomLayer, type TLayerCategory } from '../../config/types';
import type { OptionsService } from '../options-service';
import { builtInLayers } from '../../layers';
import { getParamMeta, getPublishedParams, type TModel, type TModelParam } from '../../config/models';
import type { TLayer } from '../../config/types';
import type { PaletteId } from '../palette-service';
import { PALETTE_IDS } from '../palette-service';
import type { AuroraRequest } from '../../aurora/worker';

export type LayerType = 'decoration' | 'texture' | 'geometry' | 'solid';
export type ComputeTrigger = 'data-ready' | 'time-change';
export type RenderPass = 'surface' | 'geometry' | 'post';

export interface LayerShaders {
  main?: string;               // Main pass blend shader (WGSL code)
  post?: string;               // Post-process shader
  compute?: string[];          // Compute shaders
  render?: string;             // Geometry pass render shader
}

export type { AdvectionConfig } from './advection';
import type { AdvectionConfig } from './advection';

export interface LayerDeclaration {
  id: TLayer ;
  type: LayerType;
  // UI metadata
  label: string;               // Full name (e.g., "Temperature")
  buttonLabel: string;         // Short name for UI buttons (e.g., "Temp")
  category: TLayerCategory;    // celestial, weather, reference, custom
  // Runtime config
  params?: TModelParam[];         // Data params to fetch, each with source model
  advection?: AdvectionConfig; // Wind-advected temporal interpolation
  options?: string[];          // Option paths to watch (e.g., ['temp.enabled'])
  palettes?: PaletteId[];      // Available palette IDs (first is default)
  blendFn?: string;            // Fragment shader blend function name
  postFn?: string;             // Post-process function name
  shaders?: LayerShaders;      // Inline shader code
  triggers?: Record<string, ComputeTrigger>;  // Compute stage triggers
  topology?: 'triangle-list' | 'line-list';
  config?: Record<string, unknown>;  // Layer-specific constants (serializable, transferred to worker)
  pass: RenderPass;            // Which render pass (surface, geometry, post)
  order: number;               // Render order within pass
  // Runtime fields (assigned at registration)
  index?: number;              // Uniform array index (0-15 for built-in)
  isBuiltIn?: boolean;         // true for core layers, false for user layers
  userLayerIndex?: number;     // 0-31 for user layers
}

/** Stored format for user layers in IDB */
interface StoredUserLayer {
  declaration: LayerDeclaration;
  opacity: number;
  // Note: enabled state comes from URL via sanitize(), not from IDB
}

const MAX_USER_LAYERS = 8;   // custom0..custom7
const PREVIEW_INDEX = 8;
const PREVIEW_ID = '_preview';

/** Derive custom layer ID from allocated index */
export function customLayerId(index: number): TCustomLayer {
  return CUSTOM_LAYERS[index]!;
}

/** Type guard: narrows LayerDeclaration to one with a TBuiltInLayer id */
export function isBuiltInLayer(layer: LayerDeclaration): layer is LayerDeclaration & { id: TBuiltInLayer } {
  return (BUILT_IN_LAYERS as readonly string[]).includes(layer.id);
}

/** Build a setUserLayerOptions message for a layer, including paletteRange from param metadata */
export function buildUserLayerOptions(
  layer: LayerDeclaration,
  enabled: boolean,
): Extract<AuroraRequest, { type: 'setUserLayerOptions' }> {
  const paletteIndex = layer.palettes?.[0] ? PALETTE_IDS.indexOf(layer.palettes[0]) : 0;
  const opts: Extract<AuroraRequest, { type: 'setUserLayerOptions' }> =
    { type: 'setUserLayerOptions', layerIndex: layer.userLayerIndex!, enabled, paletteIndex };
  const paramName = layer.params?.[0]?.param;
  if (paramName) {
    opts.paletteRange = getParamMeta(paramName).range as [number, number];
  }
  return opts;
}

// IDB constants
const DB_NAME = 'hypatia-zero';
const DB_VERSION = 4;  // Bump from 3 to add user-layers store
const USER_LAYERS_STORE = 'user-layers';

const MAX_BUILT_IN_LAYERS = 16;  // Indices 0-15 for built-in layers

export class LayerService {
  private layers: Map<TLayer , LayerDeclaration> = new Map();
  private changeSignal: Signal<number> = signal(0);
  private usedUserIndices: Set<number> = new Set();
  private userLayerEnabled: Map<TLayer , boolean> = new Map();
  private userLayerOpacity: Map<TLayer , number> = new Map();
  private nextBuiltInIndex = 0;  // Auto-increment for built-in layer indices
  private optionsService: OptionsService | null = null;

  /** Post-construction wiring for OptionsService */
  setOptionsService(optionsService: OptionsService): void {
    this.optionsService = optionsService;
  }

  /** Signal that increments when registry changes */
  get changed(): ReadonlySignal<number> {
    return this.changeSignal;
  }

  // ============================================================
  // IndexedDB helpers
  // ============================================================

  private async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        // Existing stores from options-service
        if (!db.objectStoreNames.contains('options')) {
          db.createObjectStore('options');
        }
        if (!db.objectStoreNames.contains('usage')) {
          db.createObjectStore('usage');
        }
        // New store for user layers
        if (!db.objectStoreNames.contains(USER_LAYERS_STORE)) {
          db.createObjectStore(USER_LAYERS_STORE);
        }
      };
    });
  }

  /**
   * Load user layers from IndexedDB
   * Call once at bootstrap, after built-in layers are registered.
   * Migrates legacy arbitrary keys → fixed custom0..custom7 IDs.
   */
  async loadUserLayers(): Promise<void> {
    try {
      const db = await this.openDB();

      // Read all entries with their keys
      const { entries, needsMigration } = await new Promise<{
        entries: Array<{ key: string; stored: StoredUserLayer }>;
        needsMigration: boolean;
      }>((resolve, reject) => {
        const tx = db.transaction(USER_LAYERS_STORE, 'readonly');
        const store = tx.objectStore(USER_LAYERS_STORE);
        const keysReq = store.getAllKeys();
        const valsReq = store.getAll();
        let keys: IDBValidKey[];
        keysReq.onsuccess = () => { keys = keysReq.result; };
        valsReq.onerror = () => reject(valsReq.error);
        valsReq.onsuccess = () => {
          const vals: StoredUserLayer[] = valsReq.result ?? []; // QC-OK: IndexedDB API
          const customSet = new Set<string>(CUSTOM_LAYERS as unknown as string[]);
          const entries = keys.map((k, i) => ({ key: String(k), stored: vals[i]! }));
          const needsMigration = entries.some(e => !customSet.has(e.key));
          resolve({ entries, needsMigration });
        };
        tx.oncomplete = () => db.close();
      });

      // Migrate legacy keys → custom0..custom7 in a single transaction
      if (needsMigration && entries.length > 0) {
        console.log(`[LayerService] Migrating ${entries.length} legacy user layer(s) to fixed IDs`);
        const migrateDb = await this.openDB();
        await new Promise<void>((resolve, reject) => {
          const tx = migrateDb.transaction(USER_LAYERS_STORE, 'readwrite');
          const store = tx.objectStore(USER_LAYERS_STORE);

          for (let i = 0; i < Math.min(entries.length, MAX_USER_LAYERS); i++) {
            const entry = entries[i]!;
            const newId = customLayerId(i);
            const oldBlendFn = entry.stored.declaration.blendFn;

            // Update declaration
            entry.stored.declaration.id = newId;
            entry.stored.declaration.userLayerIndex = i;

            // Migrate blend function name in shader source
            if (oldBlendFn && entry.stored.declaration.shaders?.main) {
              const newBlendFn = `blend${newId.charAt(0).toUpperCase()}${newId.slice(1)}`;
              entry.stored.declaration.shaders.main =
                entry.stored.declaration.shaders.main.replace(new RegExp(oldBlendFn, 'g'), newBlendFn);
              entry.stored.declaration.blendFn = newBlendFn;
            }

            // Store label from old ID if not already set
            if (!entry.stored.declaration.label || entry.stored.declaration.label === entry.key) {
              entry.stored.declaration.label = entry.key;
              entry.stored.declaration.buttonLabel = entry.key;
            }

            // Write new key, delete old key
            store.put(entry.stored, newId);
            if (entry.key !== newId) {
              store.delete(entry.key);
            }

            // Update local entry for subsequent load
            entry.key = newId;
          }

          if (entries.length > MAX_USER_LAYERS) {
            console.warn(`[LayerService] Dropped ${entries.length - MAX_USER_LAYERS} user layer(s) (max ${MAX_USER_LAYERS})`);
          }

          tx.oncomplete = () => { migrateDb.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        });
      }

      let loadedCount = 0;
      for (const { stored } of entries.slice(0, MAX_USER_LAYERS)) {
        const { declaration, opacity } = stored;
        // Validate and allocate index
        if (!declaration.id || declaration.isBuiltIn) continue;

        const index = this.allocateUserIndex();
        if (index === null) {
          console.warn(`[LayerService] No slot for user layer: ${declaration.id}`);
          continue;
        }

        // Migrate old params format (string[] → TModelParam[])
        // Pre-GFS layers only stored param names; all were IFS
        if (declaration.params?.length && typeof declaration.params[0] === 'string') {
          const oldParams = declaration.params as unknown as string[];
          const published: string[] = getPublishedParams();
          declaration.params = oldParams
            .filter(p => {
              if (published.includes(p)) return true;
              console.warn(`[LayerService] Dropping unknown param from IDB migration: ${p}`);
              return false;
            })
            .map(p => ({ model: 'ecmwf_ifs', param: p }) as TModelParam);  // QC-OK: validated against published params above
        }

        // Migrate old shader format: fn blendCustomN → fn blend, hardcoded indices → LAYER_INDEX
        if (declaration.shaders?.main) {
          let code = declaration.shaders.main;
          // Rename old blend function (blendCustom0, blendCustom1, ..., blendPreview) → blend
          code = code.replace(/fn\s+blend(?:Custom\d+|Preview)\s*\(/g, 'fn blend(');
          // Replace hardcoded user layer index with LAYER_INDEX
          code = code.replace(/getUserLayerOpacity\(\d+u\)/g, 'getUserLayerOpacity(LAYER_INDEX)');
          code = code.replace(/getUserLayerPaletteIndex\(\d+u\)/g, 'getUserLayerPaletteIndex(LAYER_INDEX)');
          // Migrate hardcoded palette range to getUserLayerPaletteRange(LAYER_INDEX)
          // Pattern: (value - -40.0) / (50.0 - -40.0) → use range accessor
          const rangePattern = /\(value\s*-\s*[-\d.]+\)\s*\/\s*\([-\d.]+\s*-\s*[-\d.]+\)/g;
          if (rangePattern.test(code) && !code.includes('getUserLayerPaletteRange')) {
            // Add import
            code = code.replace(
              /import package::aurora::shaders::layer_helpers::\{([^}]+)\}/,
              (_, imports: string) =>
                `import package::aurora::shaders::layer_helpers::{${imports.trim()}, getUserLayerPaletteRange}`
            );
            // Replace the hardcoded range math with range accessor
            code = code.replace(
              /let t = clamp\(\(value\s*-\s*([-\d.]+)\)\s*\/\s*\(([-\d.]+)\s*-\s*([-\d.]+)\),\s*0\.0,\s*1\.0\);/,
              'let range = getUserLayerPaletteRange(LAYER_INDEX);\n  let t = clamp((value - range.x) / (range.y - range.x), 0.0, 1.0);'
            );
          }
          declaration.shaders.main = code;
          declaration.blendFn = 'blend';
        }

        // Register with fresh index (don't trust stored index)
        const layer: LayerDeclaration = {
          ...declaration,
          id: declaration.id as TCustomLayer,  // QC-OK: migrated to custom0..7 above
          userLayerIndex: index,
          isBuiltIn: false,
        };
        this.layers.set(layer.id, layer);
        // Note: enabled state will be set by StateService.sanitize() from URL
        this.userLayerOpacity.set(layer.id, opacity);
        loadedCount++;
      }

      if (loadedCount > 0) {
        console.log(`[LayerService] Loaded ${loadedCount} user layer(s) from IDB`);
        this.changeSignal.value++;
      }
    } catch (err) {
      console.warn('[LayerService] Failed to load user layers:', err);
    }
  }

  /**
   * Save a user layer to IndexedDB
   */
  async saveUserLayer(id: TLayer ): Promise<void> {
    const declaration = this.layers.get(id);
    if (!declaration || declaration.isBuiltIn) return;

    const stored: StoredUserLayer = {
      declaration,
      opacity: this.userLayerOpacity.get(id)!,
      // Note: enabled state is persisted via URL, not IDB
    };

    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(USER_LAYERS_STORE, 'readwrite');
        const store = tx.objectStore(USER_LAYERS_STORE);
        store.put(stored, id);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      });
      console.log(`[LayerService] Saved user layer: ${id}`);
    } catch (err) {
      console.warn(`[LayerService] Failed to save user layer ${id}:`, err);
    }
  }

  /**
   * Delete a user layer from IndexedDB
   */
  async deleteUserLayer(id: TLayer ): Promise<void> {
    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(USER_LAYERS_STORE, 'readwrite');
        const store = tx.objectStore(USER_LAYERS_STORE);
        store.delete(id);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      });
      console.log(`[LayerService] Deleted user layer from IDB: ${id}`);
    } catch (err) {
      console.warn(`[LayerService] Failed to delete user layer ${id}:`, err);
    }
  }

  // ============================================================
  // Registry methods
  // ============================================================

  register(declaration: LayerDeclaration): void {
    // Assign index to built-in layers (user layers use userLayerIndex instead)
    if (declaration.isBuiltIn && declaration.index === undefined) {
      if (this.nextBuiltInIndex >= MAX_BUILT_IN_LAYERS) {
        console.warn(`[LayerService] Max built-in layers (${MAX_BUILT_IN_LAYERS}) reached`);
      }
      declaration.index = this.nextBuiltInIndex++;
    }
    this.layers.set(declaration.id, declaration);
    this.changeSignal.value++;
  }

  /** Register a built-in layer (sets isBuiltIn flag and assigns index) */
  registerBuiltIn(declaration: LayerDeclaration): void {
    declaration.isBuiltIn = true;
    this.register(declaration);
  }

  /** Register all built-in layers from the layers module */
  registerBuiltInLayers(): void {
    for (const layer of builtInLayers) {
      this.registerBuiltIn(layer);
    }
  }

  unregister(id: TLayer ): void {
    if (this.layers.delete(id)) {
      this.changeSignal.value++;
    }
  }

  /** Get a layer by ID */
  get(id: TLayer ): LayerDeclaration | undefined {
    return this.layers.get(id);
  }

  /** Get layer index for uniform array access (NaN if not found) */
  getLayerIndex(id: TLayer ): number {
    return this.layers.get(id)?.index ?? NaN; // QC-OK: NaN for unknown layer
  }

  getAll(): LayerDeclaration[] {
    return Array.from(this.layers.values());
  }

  /** Get layers that use a specific data param */
  getLayersForParam(param: TModelParam['param']): LayerDeclaration[] {
    return this.getAll().filter(l => l.params?.some(p => p.param === param));
  }

  /** Get layers watching a specific options path */
  getLayersWatching(optionPath: string): LayerDeclaration[] {
    return this.getAll().filter(l => l.options?.includes(optionPath));
  }

  /** Check if a layer is enabled (works for both built-in and user layers) */
  isLayerEnabled(id: TLayer ): boolean {
    const layer = this.layers.get(id);
    if (!layer) return false;

    if (isBuiltInLayer(layer)) {
      // Built-in: check OptionsService
      const opts = this.optionsService?.options.value;
      const layerOpts = opts?.[layer.id]; // narrowed to TBuiltInLayer by type guard
      return (layerOpts as { enabled?: boolean } | undefined)?.enabled ?? false; // QC-OK: dynamic options lookup
    } else {
      // User layer: check internal map
      return this.userLayerEnabled.get(id) ?? true; // QC-OK: new layers default enabled
    }
  }

  /** Get all enabled layers that have params (for TimeBar) */
  getEnabledLayers(): LayerDeclaration[] {
    return this.getAll().filter(layer => {
      if (!layer.params?.length) return false;  // No params = not a data layer
      return this.isLayerEnabled(layer.id);
    });
  }

  /** Get all unique params from a specific model + published params (IFS only) */
  getParamsForModel(model: TModel): TModelParam[] {
    const seen = new Set<string>();
    const result: TModelParam[] = [];
    for (const layer of this.layers.values()) {
      layer.params?.forEach(p => {
        if (p.model === model && !seen.has(p.param)) {
          seen.add(p.param);
          result.push(p);
        }
      });
    }
    if (model === 'ecmwf_ifs') {
      for (const param of getPublishedParams()) {
        if (!seen.has(param)) {
          seen.add(param);
          result.push({ model: 'ecmwf_ifs', param });
        }
      }
    }
    return result;
  }

  /** Get all unique model-params across all models + published IFS params */
  getAllModelParams(): TModelParam[] {
    const seen = new Set<string>();
    const result: TModelParam[] = [];
    for (const layer of this.layers.values()) {
      layer.params?.forEach(p => {
        if (!seen.has(p.param)) {
          seen.add(p.param);
          result.push(p);
        }
      });
    }
    for (const param of getPublishedParams()) {
      if (!seen.has(param)) {
        seen.add(param);
        result.push({ model: 'ecmwf_ifs', param });
      }
    }
    return result;
  }

  /** Allocate next available user layer index (0-31) */
  allocateUserIndex(): number | null {
    for (let i = 0; i < MAX_USER_LAYERS; i++) {
      if (!this.usedUserIndices.has(i)) {
        this.usedUserIndices.add(i);
        return i;
      }
    }
    return null;  // All slots full
  }

  /** Free a user layer index */
  freeUserIndex(index: number): void {
    this.usedUserIndices.delete(index);
  }

  /** Register with automatic index allocation for user layers.
   *  ID is derived from allocated index (custom0..custom7). */
  registerUserLayer(declaration: Omit<LayerDeclaration, 'id' | 'userLayerIndex'>): LayerDeclaration | null {
    const index = this.allocateUserIndex();
    if (index === null) {
      console.error(`[LayerService] No free user layer slots (max ${MAX_USER_LAYERS})`);
      return null;
    }

    const id = customLayerId(index);
    const fullDeclaration: LayerDeclaration = {
      ...declaration,
      id,
      userLayerIndex: index,
      isBuiltIn: false,
    };

    this.register(fullDeclaration);
    return fullDeclaration;
  }

  /** Unregister and free user layer index */
  unregisterUserLayer(id: TLayer ): void {
    const layer = this.layers.get(id);
    if (layer?.userLayerIndex !== undefined) {
      this.freeUserIndex(layer.userLayerIndex);
    }
    this.unregister(id);
  }

  /** Register preview layer (uses reserved slot 31) */
  registerPreview(declaration: Omit<LayerDeclaration, 'id' | 'userLayerIndex'>): LayerDeclaration {
    // Unregister existing preview if any
    this.unregisterPreview();

    const fullDeclaration: LayerDeclaration = {
      ...declaration,
      id: PREVIEW_ID,
      userLayerIndex: PREVIEW_INDEX,
      isBuiltIn: false,
    };

    this.register(fullDeclaration);
    return fullDeclaration;
  }

  /** Unregister preview layer */
  unregisterPreview(): boolean {
    if (this.layers.has(PREVIEW_ID)) {
      this.unregister(PREVIEW_ID);
      return true;
    }
    return false;
  }

  /** Check if preview exists */
  hasPreview(): boolean {
    return this.layers.has(PREVIEW_ID);
  }

  /** Get preview layer */
  getPreview(): LayerDeclaration | undefined {
    return this.layers.get(PREVIEW_ID);
  }

  /** Promote preview to permanent layer. ID derived from allocated index. */
  promotePreview(): LayerDeclaration | null {
    const preview = this.layers.get(PREVIEW_ID);
    if (!preview) return null;

    // Allocate permanent index
    const index = this.allocateUserIndex();
    if (index === null) return null;

    const id = customLayerId(index);

    // Create permanent layer
    const permanent: LayerDeclaration = {
      ...preview,
      id,
      userLayerIndex: index,
    };

    // Remove preview, add permanent
    this.unregister(PREVIEW_ID);
    this.register(permanent);

    return permanent;
  }

  /** Set user layer enabled state */
  setUserLayerEnabled(id: TLayer , enabled: boolean): void {
    this.userLayerEnabled.set(id, enabled);
    this.changeSignal.value++;
  }

  /** Toggle user layer enabled state */
  toggleUserLayer(id: TLayer ): boolean {
    const current = this.isLayerEnabled(id);
    this.setUserLayerEnabled(id, !current);
    return !current;
  }

  /** Get user layer opacity */
  getUserLayerOpacity(id: TLayer ): number {
    return this.userLayerOpacity.get(id)!;
  }

  /** Set user layer opacity */
  setUserLayerOpacity(id: TLayer , opacity: number): void {
    this.userLayerOpacity.set(id, opacity);
  }
}
