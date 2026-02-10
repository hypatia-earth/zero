/**
 * ShaderComposer - Generates WGSL shaders from LayerRegistry
 *
 * Composes shaders at runtime based on registered layers.
 * Uses main-template.wgsl as base and injects layer blend calls.
 */

import type { LayerDeclaration } from '../services/layer-registry-service';
import { getMainShaders, getPostShaders } from './shader-loader';

// Import shader modules
import commonCode from './shaders/common.wgsl?raw';
import sunAtmoCode from '../layers/sun/atmo.wgsl?raw';
import logoCode from './shaders/logo.wgsl?raw';
import mainTemplateCode from './shaders/main-template.wgsl?raw';
import sunPostCode from './shaders/sun-post.wgsl?raw';
import sunCode from './shaders/sun.wgsl?raw';
import sunBlendCode from './shaders/sun-blend.wgsl?raw';

export interface ComposedShaders {
  main: string;
  post: string;
}

// Map blend function names to their parameter signatures
const BLEND_SIGNATURES: Record<string, string> = {
  blendBasemap: '(color, hit.point)',
  blendBase: '(color, hit.point)',
  blendTemp: '(color, lat, lon)',
  blendRain: '(color, lat, lon)',
  blendSun: '(color, hit.point)',
};

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

    const surfaceLayers = layers.filter(l =>
      l.blendFn &&
      l.pass !== 'geometry' &&
      l.type !== 'decoration' || l.id === 'earth'  // earth is decoration but renders on surface
    );
    const postLayers = layers.filter(l => l.postFn);

    console.log('[ShaderComposer] Composing surface layers:',
      surfaceLayers.map(l => `${l.id}(order:${l.order ?? 0})`).join(', '));

    const main = this.composeMain(surfaceLayers, layers);
    const post = this.composePost(postLayers);

    return { main, post };
  }

  private composeMain(surfaceLayers: LayerDeclaration[], _allLayers: LayerDeclaration[]): string {
    const parts: string[] = [];

    // 1. Common utilities (ray-sphere intersection, constants)
    parts.push(sunAtmoCode);  // Atmosphere functions needed by other shaders
    parts.push(commonCode);

    // 2. Logo shader
    parts.push(logoCode);

    // 3. Layer blend functions (sorted by render order)
    const sortedLayers = [...surfaceLayers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const layer of sortedLayers) {
      const shaderCode = this.mainShaders.get(layer.id);
      if (shaderCode) {
        parts.push(`// --- Layer: ${layer.id} ---`);
        parts.push(shaderCode);
      }
    }

    // 4. Grid shader (special - always included for back-side grid logic)
    const gridShader = this.mainShaders.get('grid');
    if (gridShader) {
      parts.push('// --- Layer: grid ---');
      parts.push(gridShader);
    }

    // 5. Main template with blend calls injected
    const blendCalls = this.generateBlendCalls(sortedLayers);
    const mainCode = mainTemplateCode.replace(
      '// {{SURFACE_BLEND_CALLS}} - replaced by ShaderComposer',
      blendCalls
    );
    parts.push(mainCode);

    return parts.join('\n\n');
  }

  private composePost(_postLayers: LayerDeclaration[]): string {
    const parts: string[] = [];

    // Post shader needs Uniforms struct first (same as main shader)
    // We'll extract it from mainTemplateCode
    const uniformsMatch = mainTemplateCode.match(/struct Uniforms \{[\s\S]*?\}/);
    if (uniformsMatch) {
      parts.push(uniformsMatch[0]);
    }

    // Atmosphere functions
    parts.push(sunAtmoCode);

    // Common utilities
    parts.push(commonCode);

    // Sun shader (for atmosphere constants)
    parts.push(sunCode);

    // Sun blend functions (blendAtmosphereSpace, blendAtmosphereGlobe)
    parts.push(sunBlendCode);

    // Post-process main shader
    parts.push(sunPostCode);

    return parts.join('\n\n');
  }

  private generateBlendCalls(layers: LayerDeclaration[]): string {
    const calls: string[] = [];

    for (const layer of layers) {
      const blendFn = layer.blendFn ?? `blend${this.capitalize(layer.id)}`;
      const signature = BLEND_SIGNATURES[blendFn] ?? '(color, lat, lon)';
      calls.push(`  color = ${blendFn}${signature};`);
    }

    if (calls.length === 0) {
      return '  // No surface layers enabled';
    }

    return calls.join('\n');
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

  private capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}

/** Singleton instance */
export const shaderComposer = new ShaderComposer();
