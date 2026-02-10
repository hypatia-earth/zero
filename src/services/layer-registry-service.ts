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

export interface LayerDeclaration {
  id: string;
  type: LayerType;
  params?: string[];           // Data params to fetch (e.g., ['temp_2m'])
  options?: string[];          // Option paths to watch (e.g., ['temp.enabled'])
  blendFn?: string;            // Fragment shader blend function name
  postFn?: string;             // Post-process function name
  triggers?: Record<string, ComputeTrigger>;  // Compute stage triggers
  topology?: 'triangle-list' | 'line-list';
  pass?: RenderPass;
  order?: number;              // Render order within pass
  isBuiltIn?: boolean;         // true for core layers, false for user layers
}

export class LayerRegistryService {
  private layers: Map<string, LayerDeclaration> = new Map();
  private changeSignal: Signal<number> = signal(0);

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
}
