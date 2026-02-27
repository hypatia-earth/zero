/**
 * ShaderComposer - Composes WGSL shaders via WESL linking
 *
 * Uses WESL's import system, @if conditionals, and constants:: to compose
 * shaders from modular .wesl source files. Dynamic param bindings and
 * samplers are injected via virtual libraries.
 */

import type { LayerDeclaration, AdvectionConfig } from '../services/layer/layer-service';
import { getParamMeta, getModel, type TModel, type TModelParam } from '../config/models';
import { link } from 'wesl';

// WESL module bundles for linking
import mainWesl from './shaders/main.wesl?link';
import postWesl from '../layers/sun/post.wesl?link';

export interface ComposedShaders {
  main: string;
  post: string;
}

/** Param binding configuration */
export interface ParamBindingConfig {
  param: string;
  model: TModel;
  index: number;
  bindingSlot: number;
  gridPoints: number;
  categorical: boolean;  // true = nearest-neighbor temporal sampling
}

/** Active param registry - exported for globe-renderer to use */
export let activeParamBindings: ParamBindingConfig[] = [];

// Starting binding index for dynamic params (avoid conflicts with 0-21)
const PARAM_BINDING_START = 50;

export class ShaderComposer {
  /** Compose shaders from layer declarations via WESL linking */
  async compose(layers: LayerDeclaration[]): Promise<ComposedShaders> {
    const surfaceLayers = layers.filter(l =>
      l.blendFn &&
      l.pass !== 'geometry' &&
      l.type !== 'decoration' || l.id === 'earth'
    );

    const main = await this.composeMain(surfaceLayers, layers);
    const post = await this.composePost(layers);

    return { main, post };
  }

  private async composeMain(surfaceLayers: LayerDeclaration[], allLayers: LayerDeclaration[]): Promise<string> {
    // Build layer constants (LAYER_EARTH = 0, etc.)
    const constants: Record<string, number> = {};
    for (const layer of allLayers) {
      if (layer.index !== undefined) {
        const name = layer.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        constants[`LAYER_${name}`] = layer.index;
      }
    }

    // Build @if conditions for layer inclusion
    const hasLayer = (id: string) => surfaceLayers.some(l => l.id === id);
    const conditions: Record<string, boolean> = {
      LAYER_EARTH_ENABLED: hasLayer('earth'),
      LAYER_TEMP_ENABLED: hasLayer('temp'),
      LAYER_RAIN_ENABLED: hasLayer('rain'),
      LAYER_SUN_ENABLED: hasLayer('sun'),
    };

    // Generate param bindings virtual library
    const paramGen = this.generateParamVirtualLib(surfaceLayers);

    // Add param index constants
    for (const cfg of activeParamBindings) {
      const name = cfg.param.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      constants[`PARAM_${name}`] = cfg.index;
    }

    // Generate user layer virtual library (if any custom layers)
    const userLayers = surfaceLayers.filter(l => !l.isBuiltIn && l.shaders?.main);
    const userLayerLib = userLayers.length > 0 ? this.generateUserLayerLib(userLayers) : '';

    // Add param_gen to weslSrc so it's in the package:: namespace
    // (virtual libs can't resolve package:: imports back to the source tree)
    const weslSrc = { ...mainWesl.weslSrc, 'param_gen.wesl': paramGen };

    const virtualLibs: Record<string, () => string> = {};
    if (userLayerLib) {
      virtualLibs['user_layers'] = () => userLayerLib;
    }

    const linked = await link({
      ...mainWesl,
      weslSrc,
      conditions,
      constants,
      virtualLibs,
    });

    return linked.dest;
  }

  private async composePost(allLayers: LayerDeclaration[]): Promise<string> {
    // Post pass only needs LAYER_SUN constant
    const constants: Record<string, number> = {};
    for (const layer of allLayers) {
      if (layer.index !== undefined) {
        const name = layer.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        constants[`LAYER_${name}`] = layer.index;
      }
    }

    const linked = await link({
      ...postWesl,
      constants,
    });

    return linked.dest;
  }

  /** Generate WESL virtual library for dynamic param bindings and samplers */
  private generateParamVirtualLib(layers: LayerDeclaration[]): string {
    // 1. Collect unique params from all layers
    const allParams: TModelParam[] = [];
    const seen = new Set<string>();
    for (const layer of layers) {
      layer.params?.forEach(ref => {
        if (!seen.has(ref.param)) {
          seen.add(ref.param);
          allParams.push(ref);
        }
      });
    }

    if (allParams.length === 0) {
      activeParamBindings = [];
      return '// No dynamic params\nfn _param_gen_placeholder() {}';
    }

    // 2. Assign indices (stable ordering by param name)
    const paramList = [...allParams].sort((a, b) => a.param.localeCompare(b.param));
    const paramConfigs: ParamBindingConfig[] = paramList.map((mp, idx) => ({
      param: mp.param,
      model: mp.model,
      index: idx,
      bindingSlot: PARAM_BINDING_START + idx,
      gridPoints: getModel(mp.model).gridPoints,
      categorical: getParamMeta(mp.param).categorical ?? false,
    }));

    // Export for globe-renderer to use
    activeParamBindings = paramConfigs;

    // 3. Build WESL source with imports
    const parts: string[] = [];

    // Imports for helper functions used by samplers
    parts.push('import package::aurora::shaders::layer_helpers::{isParamReady, getParamLerp, getParamSize, getParamDt};');

    // Check if any param needs O1280 projection or common constants
    const needsProjection = paramConfigs.some(c => {
      const advection = this.getAdvectionTargets(layers).get(c.param);
      return c.model !== 'ncep_gfs025' || advection;
    });
    const needsCommon = paramConfigs.some(c => c.model === 'ncep_gfs025');

    if (needsProjection) {
      parts.push('import package::aurora::shaders::projection_o1280::o1280LatLonToCell;');
    }
    if (needsCommon) {
      parts.push('import package::aurora::shaders::common::{COMMON_PI, COMMON_TAU};');
    }

    parts.push('');

    // 4. Generate binding declarations
    for (const cfg of paramConfigs) {
      const safeName = cfg.param.replace(/[^a-zA-Z0-9]/g, '_');
      parts.push(
        `@group(0) @binding(${cfg.bindingSlot}) var<storage, read> param_${safeName}: array<f32>;`
      );
    }

    parts.push('');

    // 5. Collect advection targets
    const advectionTargets = this.getAdvectionTargets(layers);

    // 6. Generate sampler functions (wind samplers first, then advected)
    const advectedSamplers: string[] = [];

    for (const cfg of paramConfigs) {
      const safeName = cfg.param.replace(/[^a-zA-Z0-9]/g, '_');
      const advection = advectionTargets.get(cfg.param);

      if (advection) {
        const uSafe = advection.uParam.param.replace(/[^a-zA-Z0-9]/g, '_');
        const vSafe = advection.vParam.param.replace(/[^a-zA-Z0-9]/g, '_');
        const sample = cfg.categorical
          ? `select(v0, v1, lerp >= 0.5)`
          : `mix(v0, v1, lerp)`;
        const advectionBody = `
  if (!isParamReady(${cfg.index}u)) { return \${RET_ZERO}; }
  let lerp = getParamLerp(${cfg.index}u);
  let size = getParamSize(${cfg.index}u);
  let windU = sampleParam_${uSafe}(lat, lon);
  let windV = sampleParam_${vSafe}(lat, lon);
  let dt = getParamDt(${cfg.index}u);
  let R = 6371000.0;
  let cosLat = max(cos(lat), 0.01);
  let dlat = (windV * dt) / R;
  let dlon = (windU * dt) / (R * cosLat);
  let cell0 = o1280LatLonToCell(lat - dlat * lerp, lon - dlon * lerp);
  let v0 = param_${safeName}[cell0];
  let cell1 = o1280LatLonToCell(lat + dlat * (1.0 - lerp), lon + dlon * (1.0 - lerp));
  let v1 = param_${safeName}[cell1 + size];`;
        advectedSamplers.push(`
fn sampleParam_${safeName}(lat: f32, lon: f32) -> f32 {${advectionBody.replace(/\$\{RET_ZERO\}/g, '0.0')}
  return ${sample};
}`);
        // Categorical pair sampler: returns (v0, v1, lerp) for crossfade
        if (cfg.categorical) {
          advectedSamplers.push(`
fn sampleParamPair_${safeName}(lat: f32, lon: f32) -> vec3f {${advectionBody.replace(/\$\{RET_ZERO\}/g, 'vec3f(0.0)')}
  return vec3f(v0, v1, lerp);
}`);
        }
      } else if (cfg.model === 'ncep_gfs025') {
        const sample = cfg.categorical
          ? `select(v0, v1, lerp >= 0.5)`
          : `select(v0, mix(v0, v1, lerp), lerp >= 0.0)`;
        const gfsBody = `
  if (!isParamReady(${cfg.index}u)) { return \${RET_ZERO}; }
  let latF = (COMMON_PI * 0.5 - lat) * (720.0 / COMMON_PI);
  let lonWrap = lon - floor(lon / COMMON_TAU) * COMMON_TAU;
  let lonF = lonWrap * (1440.0 / COMMON_TAU);
  let latIdx = clamp(u32(latF), 0u, 720u);
  let lonIdx = u32(lonF) % 1440u;
  let cell = latIdx * 1440u + lonIdx;
  let v0 = param_${safeName}[cell];
  let v1 = param_${safeName}[cell + getParamSize(${cfg.index}u)];
  let lerp = getParamLerp(${cfg.index}u);`;
        parts.push(`
fn sampleParam_${safeName}(lat: f32, lon: f32) -> f32 {${gfsBody.replace(/\$\{RET_ZERO\}/g, '0.0')}
  return ${sample};
}`);
        if (cfg.categorical) {
          parts.push(`
fn sampleParamPair_${safeName}(lat: f32, lon: f32) -> vec3f {${gfsBody.replace(/\$\{RET_ZERO\}/g, 'vec3f(0.0)')}
  return vec3f(v0, v1, lerp);
}`);
        }
      } else {
        const sample = cfg.categorical
          ? `select(v0, v1, lerp >= 0.5)`
          : `select(v0, mix(v0, v1, lerp), lerp >= 0.0)`;
        parts.push(`
fn sampleParam_${safeName}(cell: u32) -> f32 {
  if (!isParamReady(${cfg.index}u)) { return 0.0; }
  let v0 = param_${safeName}[cell];
  let v1 = param_${safeName}[cell + getParamSize(${cfg.index}u)];
  let lerp = getParamLerp(${cfg.index}u);
  return ${sample};
}`);
        if (cfg.categorical) {
          parts.push(`
fn sampleParamPair_${safeName}(cell: u32) -> vec3f {
  if (!isParamReady(${cfg.index}u)) { return vec3f(0.0); }
  let v0 = param_${safeName}[cell];
  let v1 = param_${safeName}[cell + getParamSize(${cfg.index}u)];
  let lerp = getParamLerp(${cfg.index}u);
  return vec3f(v0, v1, lerp);
}`);
        }
      }
    }

    // Advected samplers after wind samplers (dependency order)
    parts.push(...advectedSamplers);

    return parts.join('\n');
  }

  /** Collect advection targets from layer declarations */
  private getAdvectionTargets(layers: LayerDeclaration[]): Map<string, AdvectionConfig> {
    const targets = new Map<string, AdvectionConfig>();
    for (const layer of layers) {
      if (layer.advection) {
        for (const target of layer.advection.targets) {
          targets.set(target.param, layer.advection);
        }
      }
    }
    return targets;
  }

  /** Generate virtual library for user/custom layer blend functions */
  private generateUserLayerLib(userLayers: LayerDeclaration[]): string {
    const parts: string[] = [];
    for (const layer of userLayers) {
      if (layer.shaders?.main) {
        parts.push(layer.shaders.main);
      }
    }
    return parts.join('\n');
  }
}

/** Singleton instance */
export const shaderComposer = new ShaderComposer();
