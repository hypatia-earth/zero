/**
 * ShaderComposer - Generates WGSL shaders from LayerRegistry
 *
 * Composes shaders at runtime based on registered layers.
 * Uses main-template.wgsl as base and injects layer blend calls.
 */

import type { LayerDeclaration } from '../services/layer/layer-service';
import { getMainShaders, getPostShaders } from './shader-loader';

// Import shader modules
import commonCode from './shaders/common.wgsl?raw';
import projectionO1280Code from './shaders/projection-o1280.wgsl?raw';
import layerHelpersCode from './shaders/layer-helpers.wgsl?raw';
import sunAtmoCode from '../layers/sun/atmo.wgsl?raw';
import logoCode from './shaders/logo.wgsl?raw';
import mainTemplateCode from './shaders/main-template.wgsl?raw';
import sunPostCode from '../layers/sun/post.wgsl?raw';
import sunCode from '../layers/sun/sun.wgsl?raw';
import sunBlendCode from '../layers/sun/blend.wgsl?raw';

export interface ComposedShaders {
  main: string;
  post: string;
}

/** Generated param shader code */
interface GeneratedParamShader {
  bindings: string;   // @group(0) @binding(...) declarations
  samplers: string;   // sampleParam_X(cell) function code
}

/** Param binding configuration */
export interface ParamBindingConfig {
  param: string;
  index: number;
  bindingSlot0: number;
  bindingSlot1: number;
}

/** Active param registry - exported for globe-renderer to use */
export let activeParamBindings: ParamBindingConfig[] = [];

// Starting binding index for dynamic params (avoid conflicts with 0-21)
const PARAM_BINDING_START = 50;

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
      surfaceLayers.map(l => `${l.id}(order:${l.order})`).join(', '));

    const main = this.composeMain(surfaceLayers, layers);
    const post = this.composePost(postLayers, layers);

    return { main, post };
  }

  private composeMain(surfaceLayers: LayerDeclaration[], allLayers: LayerDeclaration[]): string {
    const parts: string[] = [];

    // 1. Layer index constants (must come before layer shaders that use them)
    const layerConstants = this.generateLayerConstants(allLayers);
    parts.push(layerConstants);

    // 2. Uniforms struct and helper functions (must come before layer shaders)
    parts.push(layerHelpersCode);

    // 3. Common utilities (ray-sphere intersection, constants)
    parts.push(sunAtmoCode);  // Atmosphere functions needed by other shaders
    parts.push(commonCode);
    parts.push(projectionO1280Code);  // O1280 Gaussian grid projection

    // 3. Logo shader
    parts.push(logoCode);

    // 3. Layer blend functions (sorted by render order)
    const sortedLayers = [...surfaceLayers].sort((a, b) => (a.order) - (b.order));
    for (const layer of sortedLayers) {
      // Prefer inline shader from declaration, fall back to shader-loader
      const shaderCode = layer.shaders?.main ?? this.mainShaders.get(layer.id);
      if (shaderCode) {
        parts.push(`// --- Layer: ${layer.id} ---`);
        parts.push(shaderCode);
      }
    }

    // 4. Graticule shader (special - always included for back-side graticule logic)
    const graticuleLayer = allLayers.find(l => l.id === 'graticule');
    const graticuleShader = graticuleLayer?.shaders?.main ?? this.mainShaders.get('graticule');
    if (graticuleShader) {
      parts.push('// --- Layer: graticule ---');
      parts.push(graticuleShader);
    }

    // 5. Generate dynamic param bindings
    const paramShader = this.generateParamBindings(allLayers);

    // 6. Main template with blend calls and param bindings injected
    // Note: Layer constants are injected at the beginning of the shader (step 1)
    const blendCalls = this.generateBlendCalls(sortedLayers);
    const mainCode = mainTemplateCode
      .replace('// {{SURFACE_BLEND_CALLS}} - replaced by ShaderComposer', blendCalls)
      .replace('// {{PARAM_BINDINGS}} - Dynamic param buffer bindings (generated by ShaderComposer)', paramShader.bindings)
      .replace('// {{PARAM_SAMPLERS}} - Dynamic param sampler functions (generated by ShaderComposer)', paramShader.samplers)
      .replace('// {{LAYER_CONSTANTS}} - Layer index constants (generated by ShaderComposer)', '// (layer constants at top of shader)');
    parts.push(mainCode);

    return parts.join('\n\n');
  }

  private composePost(_postLayers: LayerDeclaration[], allLayers: LayerDeclaration[]): string {
    const parts: string[] = [];

    // 1. Layer index constants (LAYER_SUN needed for atmosphere blend)
    const layerConstants = this.generateLayerConstants(allLayers);
    parts.push(layerConstants);

    // 2. Uniforms struct and helpers (from layer-helpers.wgsl)
    parts.push(layerHelpersCode);

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

  /** Generate dynamic param bindings and sampler functions */
  private generateParamBindings(layers: LayerDeclaration[]): GeneratedParamShader {
    // 1. Collect unique params from all layers
    const allParams = new Set<string>();
    for (const layer of layers) {
      layer.params?.forEach(p => allParams.add(p));
    }

    if (allParams.size === 0) {
      activeParamBindings = [];
      return { bindings: '// No dynamic params', samplers: '// No param samplers' };
    }

    // 2. Assign indices (stable ordering)
    const paramList = [...allParams].sort();
    const paramConfigs: ParamBindingConfig[] = paramList.map((param, idx) => ({
      param,
      index: idx,
      bindingSlot0: PARAM_BINDING_START + idx * 2,
      bindingSlot1: PARAM_BINDING_START + idx * 2 + 1,
    }));

    // Export for globe-renderer to use
    activeParamBindings = paramConfigs;

    // 3. Generate binding declarations
    const bindings: string[] = ['// --- Dynamic param bindings (generated) ---'];
    for (const cfg of paramConfigs) {
      const safeName = cfg.param.replace(/[^a-zA-Z0-9]/g, '_');
      bindings.push(
        `@group(0) @binding(${cfg.bindingSlot0}) var<storage, read> param_${safeName}_0: array<f32>;`,
        `@group(0) @binding(${cfg.bindingSlot1}) var<storage, read> param_${safeName}_1: array<f32>;`
      );
    }

    // 4. Generate sampler functions
    const samplers: string[] = ['// --- Param samplers (generated) ---'];
    for (const cfg of paramConfigs) {
      const safeName = cfg.param.replace(/[^a-zA-Z0-9]/g, '_');
      samplers.push(`
fn sampleParam_${safeName}(cell: u32) -> f32 {
  if (!isParamReady(${cfg.index}u)) { return 0.0; }
  let v0 = param_${safeName}_0[cell];
  let v1 = param_${safeName}_1[cell];
  let lerp = getParamLerp(${cfg.index}u);
  return select(v0, mix(v0, v1, lerp), lerp >= 0.0);
}`);
    }

    return {
      bindings: bindings.join('\n'),
      samplers: samplers.join('\n'),
    };
  }

  /** Generate layer index constants (LAYER_EARTH = 0u, etc.) */
  private generateLayerConstants(layers: LayerDeclaration[]): string {
    const constants: string[] = ['// --- Layer index constants (generated) ---'];

    for (const layer of layers) {
      if (layer.index !== undefined) {
        const name = layer.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        constants.push(`const LAYER_${name}: u32 = ${layer.index}u;`);
      }
    }

    if (constants.length === 1) {
      return '// No layer constants';
    }

    return constants.join('\n');
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
      .sort((a, b) => (a.order) - (b.order))
      .map(l => l.blendFn ?? l.id);
  }

  private capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}

/** Singleton instance */
export const shaderComposer = new ShaderComposer();
