/**
 * ShaderComposer - Composes WGSL shaders via WESL linking
 *
 * Uses WESL's import system, @if conditionals, and constants:: to compose
 * shaders from modular .wesl source files. Param samplers are static .wesl
 * modules in aurora/shaders/params/. Dynamic param indices are injected as
 * constants::. User layer blend functions use the user_layers virtual library.
 */

import type { LayerDeclaration } from '../services/layer/layer-service';
import { getModel, type TModel, type TModelParam } from '../config/models';
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

/** Static registry: fixed binding slots and metadata for all known params */
const PARAM_REGISTRY: Record<string, { bindingSlot: number; model: TModel; categorical: boolean }> = {
  temperature_2m:              { bindingSlot: 50, model: 'ecmwf_ifs',   categorical: false },
  precipitation:               { bindingSlot: 51, model: 'ecmwf_ifs',   categorical: false },
  precipitation_type:          { bindingSlot: 52, model: 'ecmwf_ifs',   categorical: true },
  wind_u_component_1000hPa:    { bindingSlot: 53, model: 'ncep_gfs025', categorical: false },
  wind_v_component_1000hPa:    { bindingSlot: 54, model: 'ncep_gfs025', categorical: false },
  cloud_cover:                 { bindingSlot: 55, model: 'ecmwf_ifs',   categorical: false },
  pressure_msl:                { bindingSlot: 56, model: 'ecmwf_ifs',   categorical: false },
  wind_u_component_10m:        { bindingSlot: 57, model: 'ecmwf_ifs',   categorical: false },
  wind_v_component_10m:        { bindingSlot: 58, model: 'ecmwf_ifs',   categorical: false },
};

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

    // Compute param bindings from static registry + active layers
    this.computeParamBindings(surfaceLayers);

    // Inject PARAM_* index constants for all registered params
    // Active params get their compact index; inactive default to 0 (tree-shaken)
    const activeIndex = new Map(activeParamBindings.map(cfg => [cfg.param, cfg.index]));
    for (const paramName of Object.keys(PARAM_REGISTRY)) {
      const constName = `PARAM_${paramName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      constants[constName] = activeIndex.get(paramName) ?? 0;
    }

    // Generate user layer virtual library (if any custom layers)
    const userLayers = surfaceLayers.filter(l => !l.isBuiltIn && l.shaders?.main);
    const userLayerLib = userLayers.length > 0 ? this.generateUserLayerLib(userLayers) : '';

    const virtualLibs: Record<string, () => string> = {};
    if (userLayerLib) {
      virtualLibs['user_layers'] = () => userLayerLib;
    }

    const linked = await link({
      ...mainWesl,
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

  /** Compute activeParamBindings from static registry + active layer params */
  private computeParamBindings(layers: LayerDeclaration[]): void {
    const seen = new Set<string>();
    const uniqueParams: TModelParam[] = [];
    for (const layer of layers) {
      layer.params?.forEach(ref => {
        if (!seen.has(ref.param)) {
          seen.add(ref.param);
          uniqueParams.push(ref);
        }
      });
    }

    const sorted = [...uniqueParams].sort((a, b) => a.param.localeCompare(b.param));
    activeParamBindings = sorted.map((mp, idx) => {
      const entry = PARAM_REGISTRY[mp.param];
      if (!entry) throw new Error(`Unknown param: ${mp.param} — add it to PARAM_REGISTRY`);
      return {
        param: mp.param,
        model: entry.model,
        index: idx,
        bindingSlot: entry.bindingSlot,
        gridPoints: getModel(entry.model).gridPoints,
        categorical: entry.categorical,
      };
    });
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
