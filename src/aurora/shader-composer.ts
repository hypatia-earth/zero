/**
 * ShaderComposer - Composes WGSL shaders via WESL linking
 *
 * Uses WESL's import system, @if conditionals, and constants:: to compose
 * shaders from modular .wesl source files. Param samplers are static .wesl
 * modules in aurora/shaders/params/. Dynamic param indices are injected as
 * constants::. User layer blend functions are injected via virtualLibs.
 */

import type { LayerDeclaration } from '../services/layer/layer-service';
import { getModel, type TModel } from '../config/models';
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
  packed?: boolean;      // true = shares binding slot with partner (no own layout entry)
}

/** Active param registry - exported for globe-renderer to use */
export let activeParamBindings: ParamBindingConfig[] = [];

/** Static registry: fixed binding slots and metadata for all known params.
 *  packWith: shares binding slot with named partner (v packed into u's buffer) */
const PARAM_REGISTRY: Record<string, { bindingSlot: number; model: TModel; categorical: boolean; packWith?: string }> = {
  temperature_2m:              { bindingSlot: 50, model: 'ecmwf_ifs',   categorical: false },
  precipitation:               { bindingSlot: 51, model: 'ecmwf_ifs',   categorical: false },
  precipitation_type:          { bindingSlot: 52, model: 'ecmwf_ifs',   categorical: true },
  wind_u_component_1000hPa:    { bindingSlot: 53, model: 'ncep_gfs025', categorical: false },
  wind_v_component_1000hPa:    { bindingSlot: 53, model: 'ncep_gfs025', categorical: false, packWith: 'wind_u_component_1000hPa' },
  cloud_cover:                 { bindingSlot: 55, model: 'ecmwf_ifs',   categorical: false },
  pressure_msl:                { bindingSlot: 56, model: 'ecmwf_ifs',   categorical: false },
  wind_u_component_10m:        { bindingSlot: 57, model: 'ecmwf_ifs',   categorical: false },
  wind_v_component_10m:        { bindingSlot: 57, model: 'ecmwf_ifs',   categorical: false, packWith: 'wind_u_component_10m' },
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
      LAYER_CITIES_ENABLED: allLayers.some(l => l.id === 'cities'),
    };

    // User layer conditions (slots 0-7 + preview at 8)
    const userLayers = surfaceLayers.filter(l => !l.isBuiltIn && l.shaders?.main);
    for (let i = 0; i < 8; i++) {
      conditions[`USER_LAYER_${i}_ENABLED`] = userLayers.some(l => l.userLayerIndex === i);
    }
    conditions['USER_LAYER_PREVIEW_ENABLED'] = userLayers.some(l => l.id === '_preview');

    // Compute param bindings from full registry (all slots always active)
    this.computeParamBindings();

    // Inject PARAM_* index constants for all registered params (all always active)
    const activeIndex = new Map(activeParamBindings.map(cfg => [cfg.param, cfg.index]));
    for (const paramName of Object.keys(PARAM_REGISTRY)) {
      const constName = `PARAM_${paramName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      constants[constName] = activeIndex.get(paramName)!;
    }

    // Per-layer virtual modules (each user layer gets its own module)
    // Each module gets a LAYER_INDEX const injected after imports so users write LAYER_INDEX instead of a hardcoded index
    const virtualLibs: Record<string, () => string> = {};
    for (const layer of userLayers) {
      const idx = layer.userLayerIndex!;
      const moduleName = layer.id === '_preview' ? 'user_layer_preview' : `user_layer_${idx}`;
      virtualLibs[moduleName] = () => {
        // WESL requires imports before declarations — inject const after all import lines
        const lines = layer.shaders!.main!.split('\n');
        const imports: string[] = [];
        const body: string[] = [];
        let pastImports = false;
        for (const line of lines) {
          const trimmed = line.trimStart();
          if (!pastImports && (trimmed.startsWith('import ') || trimmed === '' || trimmed.startsWith('//'))) {
            // Strip constants:: imports — LAYER_INDEX is injected as a per-module const below
            if (trimmed.startsWith('import constants::')) continue;
            imports.push(line);
          } else {
            pastImports = true;
            body.push(line);
          }
        }
        return [...imports, `const LAYER_INDEX: u32 = ${idx}u;`, '', ...body].join('\n');
      };
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

  /** Compute activeParamBindings from full PARAM_REGISTRY.
   *  Params with packWith share their partner's binding slot and don't get
   *  their own layout entry — they still get a param index for uniform lookups. */
  private computeParamBindings(): void {
    const sorted = Object.entries(PARAM_REGISTRY)
      .sort(([a], [b]) => a.localeCompare(b));
    activeParamBindings = sorted.map(([param, entry], idx) => ({
      param,
      model: entry.model,
      index: idx,
      bindingSlot: entry.bindingSlot,
      gridPoints: getModel(entry.model).gridPoints,
      categorical: entry.categorical,
      packed: !!entry.packWith,
    }));
  }

}

/** Singleton instance */
export const shaderComposer = new ShaderComposer();
