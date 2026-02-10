/**
 * LayerRegistryService - Dynamic registry of all layers (built-in and user)
 *
 * Single source of truth for layer configuration. Both V1 and V2
 * workers query this registry to determine which layers exist
 * and their configurations.
 */

import { signal, type Signal, type ReadonlySignal } from '@preact/signals-core';

export type LayerType = 'decoration' | 'texture' | 'geometry' | 'solid';
export type ComputeTrigger = 'data-ready' | 'time-change';
export type RenderPass = 'surface' | 'geometry' | 'post';

export interface LayerShaders {
  main?: string;               // Main pass blend shader (WGSL code)
  post?: string;               // Post-process shader
  compute?: string[];          // Compute shaders
  render?: string;             // Geometry pass render shader
}

export interface LayerDeclaration {
  id: string;
  type: LayerType;
  params?: string[];           // Data params to fetch (e.g., ['temp_2m'])
  options?: string[];          // Option paths to watch (e.g., ['temp.enabled'])
  blendFn?: string;            // Fragment shader blend function name
  postFn?: string;             // Post-process function name
  shaders?: LayerShaders;      // Inline shader code
  triggers?: Record<string, ComputeTrigger>;  // Compute stage triggers
  topology?: 'triangle-list' | 'line-list';
  pass?: RenderPass;
  order?: number;              // Render order within pass
  isBuiltIn?: boolean;         // true for core layers, false for user layers
  userLayerIndex?: number;     // 0-31 for user layers (uniform slot index)
}

const MAX_USER_LAYERS = 31;  // 0-30, index 31 reserved for preview
const PREVIEW_INDEX = 31;
const PREVIEW_ID = '_preview';

export class LayerRegistryService {
  private layers: Map<string, LayerDeclaration> = new Map();
  private changeSignal: Signal<number> = signal(0);
  private usedUserIndices: Set<number> = new Set();
  private userLayerEnabled: Map<string, boolean> = new Map();
  private userLayerOpacity: Map<string, number> = new Map();

  /** Signal that increments when registry changes */
  get changed(): ReadonlySignal<number> {
    return this.changeSignal;
  }

  register(declaration: LayerDeclaration): void {
    this.layers.set(declaration.id, declaration);
    this.changeSignal.value++;
  }

  unregister(id: string): void {
    if (this.layers.delete(id)) {
      this.changeSignal.value++;
    }
  }

  get(id: string): LayerDeclaration | undefined {
    return this.layers.get(id);
  }

  getAll(): LayerDeclaration[] {
    return Array.from(this.layers.values());
  }

  getBuiltIn(): LayerDeclaration[] {
    return this.getAll().filter(l => l.isBuiltIn);
  }

  getUserLayers(): LayerDeclaration[] {
    return this.getAll().filter(l => !l.isBuiltIn);
  }

  /** Get layers that use a specific data param */
  getLayersForParam(param: string): LayerDeclaration[] {
    return this.getAll().filter(l => l.params?.includes(param));
  }

  /** Get layers watching a specific options path */
  getLayersWatching(optionPath: string): LayerDeclaration[] {
    return this.getAll().filter(l => l.options?.includes(optionPath));
  }

  /** Get all unique params needed by registered layers */
  getAllParams(): string[] {
    const params = new Set<string>();
    for (const layer of this.layers.values()) {
      layer.params?.forEach(p => params.add(p));
    }
    return Array.from(params);
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
      console.error('[LayerRegistry] No free user layer slots (max 32)');
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

  /** Check if user layer is enabled (defaults to true) */
  isUserLayerEnabled(id: string): boolean {
    return this.userLayerEnabled.get(id) ?? true;
  }

  /** Set user layer enabled state */
  setUserLayerEnabled(id: string, enabled: boolean): void {
    this.userLayerEnabled.set(id, enabled);
    this.changeSignal.value++;
  }

  /** Toggle user layer enabled state */
  toggleUserLayer(id: string): boolean {
    const current = this.isUserLayerEnabled(id);
    this.setUserLayerEnabled(id, !current);
    return !current;
  }

  /** Get user layer opacity (defaults to 1.0) */
  getUserLayerOpacity(id: string): number {
    return this.userLayerOpacity.get(id) ?? 1.0;
  }

  /** Set user layer opacity */
  setUserLayerOpacity(id: string, opacity: number): void {
    this.userLayerOpacity.set(id, opacity);
  }
}
