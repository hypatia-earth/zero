/**
 * ShaderComposer - Generates WGSL shaders from LayerRegistry
 *
 * Replaces static wgsl-plus build with runtime composition.
 * Key responsibilities:
 * - Generate uniform struct based on registered layers
 * - Generate fs_main() with layer blend calls
 * - Support user-defined solid color layers (Joker test)
 */

import type { LayerDeclaration } from '../services/layer-registry-service';
import { getMainShaders, getPostShaders } from './shader-loader';

export interface ComposedShaders {
  main: string;
  post: string;
}

export class ShaderComposer {
  private initialized = false;
  private mainShaders: Map<string, string> = new Map();
  private postShaders: Map<string, string> = new Map();

  /** Initialize with shader code from shader-loader */
  init(): void {
    if (this.initialized) return;
    this.mainShaders = getMainShaders();
    this.postShaders = getPostShaders();
    this.initialized = true;
    console.log('[ShaderComposer] Initialized with layers:', Array.from(this.mainShaders.keys()).join(', '));
  }

  /** Compose shader from layer declarations */
  compose(layers: LayerDeclaration[]): ComposedShaders {
    if (!this.initialized) {
      this.init();
    }

    const surfaceLayers = layers.filter(l => l.blendFn && l.pass !== 'geometry');
    const postLayers = layers.filter(l => l.postFn);

    // Log what we would compose
    console.log('[ShaderComposer] Would compose surface layers:',
      surfaceLayers.map(l => `${l.id}(order:${l.order ?? 0})`).join(', '));

    if (postLayers.length > 0) {
      console.log('[ShaderComposer] Would compose post layers:',
        postLayers.map(l => l.id).join(', '));
    }

    // For now, return empty - actual composition requires shader templates
    // This will be filled in when we have the main.wgsl template refactored
    return {
      main: '', // TODO: compose actual shader
      post: '', // TODO: compose post shader
    };
  }

  /** Check if layer has main shader code available */
  hasLayerShader(layerId: string): boolean {
    return this.mainShaders.has(layerId);
  }

  /** Check if layer has post shader code available */
  hasPostShader(layerId: string): boolean {
    return this.postShaders.has(layerId);
  }

  /** Get blend order for fs_main composition */
  getBlendOrder(layers: LayerDeclaration[]): string[] {
    return layers
      .filter(l => l.blendFn && l.pass !== 'geometry')
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(l => l.blendFn ?? l.id);
  }
}

/** Singleton instance */
export const shaderComposer = new ShaderComposer();
