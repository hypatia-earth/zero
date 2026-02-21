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
import type { TLayerCategory, SlabConfig } from '../../config/types';
import type { OptionsService } from '../options-service';
import { builtInLayers } from '../../layers';
import { getPublishedParams, type TModel, type TModelParam } from '../../config/models';
import type { PaletteId } from '../palette-service';

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
  id: string;
  type: LayerType;
  // UI metadata
  label: string;               // Full name (e.g., "Temperature")
  buttonLabel: string;         // Short name for UI buttons (e.g., "Temp")
  category: TLayerCategory;    // celestial, weather, reference, custom
  // Runtime config
  params?: TModelParam[];         // Data params to fetch, each with source model
  advection?: AdvectionConfig; // Wind-advected temporal interpolation
  slabs?: SlabConfig[];        // GPU buffer slabs (e.g., [{ name: 'data', sizeMB: 26 }])
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

const MAX_USER_LAYERS = 31;  // 0-30, index 31 reserved for preview
const PREVIEW_INDEX = 31;
const PREVIEW_ID = '_preview';

// IDB constants
const DB_NAME = 'hypatia-zero';
const DB_VERSION = 4;  // Bump from 3 to add user-layers store
const USER_LAYERS_STORE = 'user-layers';

const MAX_BUILT_IN_LAYERS = 16;  // Indices 0-15 for built-in layers

export class LayerService {
  private layers: Map<string, LayerDeclaration> = new Map();
  private changeSignal: Signal<number> = signal(0);
  private usedUserIndices: Set<number> = new Set();
  private userLayerEnabled: Map<string, boolean> = new Map();
  private userLayerOpacity: Map<string, number> = new Map();
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
   * Call once at bootstrap, after built-in layers are registered
   */
  async loadUserLayers(): Promise<void> {
    try {
      const db = await this.openDB();
      const layers = await new Promise<StoredUserLayer[]>((resolve, reject) => {
        const tx = db.transaction(USER_LAYERS_STORE, 'readonly');
        const store = tx.objectStore(USER_LAYERS_STORE);
        const request = store.getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result ?? []); // QC-OK: IndexedDB API
        tx.oncomplete = () => db.close();
      });

      let loadedCount = 0;
      for (const stored of layers) {
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

        // Register with fresh index (don't trust stored index)
        const layer: LayerDeclaration = {
          ...declaration,
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
  async saveUserLayer(id: string): Promise<void> {
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
  async deleteUserLayer(id: string): Promise<void> {
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

  unregister(id: string): void {
    if (this.layers.delete(id)) {
      this.changeSignal.value++;
    }
  }

  /** Get a layer by ID */
  get(id: string): LayerDeclaration | undefined {
    return this.layers.get(id);
  }

  /** Get layer index for uniform array access (NaN if not found) */
  getLayerIndex(id: string): number {
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
  isLayerEnabled(id: string): boolean {
    const layer = this.layers.get(id);
    if (!layer) return false;

    if (layer.isBuiltIn) {
      // Built-in: check OptionsService
      const opts = this.optionsService?.options.value;
      const layerOpts = opts?.[id as keyof typeof opts] as { enabled?: boolean } | undefined;
      return layerOpts?.enabled ?? false; // QC-OK: dynamic options lookup
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

  /** Register with automatic index allocation for user layers */
  registerUserLayer(declaration: Omit<LayerDeclaration, 'userLayerIndex'>): LayerDeclaration | null {
    const index = this.allocateUserIndex();
    if (index === null) {
      console.error('[LayerService] No free user layer slots (max 32)');
      return null;
    }

    const fullDeclaration: LayerDeclaration = {
      ...declaration,
      userLayerIndex: index,
      isBuiltIn: false,
    };

    this.register(fullDeclaration);
    return fullDeclaration;
  }

  /** Unregister and free user layer index */
  unregisterUserLayer(id: string): void {
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

  /** Promote preview to permanent layer with given ID */
  promotePreview(id: string): LayerDeclaration | null {
    const preview = this.layers.get(PREVIEW_ID);
    if (!preview) return null;

    // Allocate permanent index
    const index = this.allocateUserIndex();
    if (index === null) return null;

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
  setUserLayerEnabled(id: string, enabled: boolean): void {
    this.userLayerEnabled.set(id, enabled);
    this.changeSignal.value++;
  }

  /** Toggle user layer enabled state */
  toggleUserLayer(id: string): boolean {
    const current = this.isLayerEnabled(id);
    this.setUserLayerEnabled(id, !current);
    return !current;
  }

  /** Get user layer opacity */
  getUserLayerOpacity(id: string): number {
    return this.userLayerOpacity.get(id)!;
  }

  /** Set user layer opacity */
  setUserLayerOpacity(id: string, opacity: number): void {
    this.userLayerOpacity.set(id, opacity);
  }
}
