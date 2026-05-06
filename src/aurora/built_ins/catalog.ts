/**
 * Aurora's built-in layer catalog — pure data, source of truth for
 * built-in layer metadata. Both main thread and worker import from here;
 * the host adapts entries into its `LayerDeclaration` shape via a shim
 * during migration (see `src/layers/index.ts`).
 *
 * Phase 6 of aurora-autarky Sub-B (catalog inversion). All 9 built-ins
 * declared here. Composed-layer GPU config (sun/rain/clouds withConfig
 * entries with U.* offsets) is absorbed into `config` fields below;
 * worker writes them via `writeConfigUniforms(uniformView, layer.config)`
 * at init.
 *
 * Order is load-bearing: LayerService.registerBuiltIn assigns
 * `layer.index` by registration order, and shader-composer emits
 * `LAYER_<ID>` constants pinned to those indices.
 */

import { U } from '../globe-uniforms';
import type { LayerCatalogEntry } from '../types/layer-catalog';

export const LAYER_CATALOG: readonly LayerCatalogEntry[] = [
  {
    id: 'earth',
    type: 'decoration',
    uiHints: { defaultLabel: 'Earth', defaultCategory: 'celestial' },
    blendFn: 'blendBasemap',
    pass: 'surface',
    order: 0,
  },
  {
    id: 'sun',
    type: 'decoration',
    uiHints: { defaultLabel: 'Sun', defaultCategory: 'celestial' },
    blendFn: 'blendSun',
    postFn: 'postSun',
    config: {
      coreRadius: { value: 0.015, type: 'f32', pos: U.sunCoreRadius },
      glowRadius: { value: 0.12,  type: 'f32', pos: U.sunGlowRadius },
      coreColor:  { value: [1.0, 0.7, 0.3], type: 'vec3f', pos: U.sunCoreColor },
      glowColor:  { value: [1.0, 0.6, 0.2], type: 'vec3f', pos: U.sunGlowColor },
    },
    pass: 'surface',
    order: 100,
  },
  {
    id: 'graticule',
    type: 'decoration',
    uiHints: { defaultLabel: 'Grid', defaultCategory: 'reference' },
  },
  {
    id: 'cities',
    type: 'decoration',
    uiHints: { defaultLabel: 'Cities', defaultCategory: 'reference' },
  },
  {
    id: 'temp',
    type: 'texture',
    uiHints: { defaultLabel: 'Temperature', defaultCategory: 'weather' },
    params: [{ model: 'ecmwf_ifs', param: 'temperature_2m' }],
    palettes: ['temp-classic', 'temp-hypatia', 'simple-gradient'],
    blendFn: 'blendTemp',
    pass: 'surface',
    order: 10,
  },
  {
    id: 'rain',
    type: 'texture',
    uiHints: { defaultLabel: 'Precipitation', defaultCategory: 'weather' },
    params: [
      { model: 'ecmwf_ifs', param: 'snowfall_water_equivalent' },
      { model: 'ecmwf_ifs', param: 'precipitation' },
      { model: 'ncep_gfs025', param: 'wind_u_component_1000hPa' },
      { model: 'ncep_gfs025', param: 'wind_v_component_1000hPa' },
    ],
    advection: {
      uParam: { model: 'ncep_gfs025', param: 'wind_u_component_1000hPa' },
      vParam: { model: 'ncep_gfs025', param: 'wind_v_component_1000hPa' },
      targets: [
        { model: 'ecmwf_ifs', param: 'snowfall_water_equivalent' },
        { model: 'ecmwf_ifs', param: 'precipitation' },
      ],
    },
    palettes: ['rain-wet-intensity', 'rain-frozen-intensity'],
    config: {
      density:      { value: 0.16,   type: 'f32', pos: U.rainDensity },
      sizePx:       { value: 0.5625, type: 'f32', pos: U.rainSizePx },
      fadeDuration: { value: 3.0,    type: 'f32', pos: U.rainFadeDuration },
      minMm:        { value: 0.1,    type: 'f32', pos: U.rainMinMm },
      colors: {
        rain: [0.7, 0.85, 1.0],
        snow: [1.0, 1.0, 1.0],
      },
    },
    blendFn: 'blendRain',
    pass: 'surface',
    order: 20,
  },
  {
    id: 'clouds',
    type: 'texture',
    uiHints: { defaultLabel: 'Clouds', defaultCategory: 'weather' },
    params: [
      { model: 'ecmwf_ifs', param: 'cloud_cover' },
      { model: 'ncep_gfs025', param: 'wind_u_component_1000hPa' },
      { model: 'ncep_gfs025', param: 'wind_v_component_1000hPa' },
    ],
    advection: {
      uParam: { model: 'ncep_gfs025', param: 'wind_u_component_1000hPa' },
      vParam: { model: 'ncep_gfs025', param: 'wind_v_component_1000hPa' },
      targets: [
        { model: 'ecmwf_ifs', param: 'cloud_cover' },
      ],
    },
    config: {
      brightness:     { value: 0.85, type: 'f32', pos: U.cloudsBrightness },
      shadowStrength: { value: 0.8,  type: 'f32', pos: U.cloudsShadowStrength },
      edgeBrightness: { value: 0.25, type: 'f32', pos: U.cloudsEdgeBrightness },
      coverageMin:    { value: 18.0, type: 'f32', pos: U.cloudsCoverageMin },
      noiseStrength:  { value: 0.2,  type: 'f32', pos: U.cloudsNoiseStrength },
      noiseSpeed:     { value: 0.3,  type: 'f32', pos: U.cloudsNoiseSpeed },
      warmthTint:     { value: 0.6,  type: 'f32', pos: U.cloudsWarmthTint },
      edgeSteps:      { value: 3.0,  type: 'f32', pos: U.cloudsEdgeSteps },
    },
    blendFn: 'blendClouds',
    pass: 'surface',
    order: 30,
  },
  {
    id: 'pressure',
    uiHints: { defaultLabel: 'Pressure', defaultCategory: 'weather' },
    params: [{ model: 'ecmwf_ifs', param: 'pressure_msl' }],
    palettes: ['pressure-gradient'],
  },
  {
    id: 'wind',
    uiHints: { defaultLabel: 'Wind', defaultCategory: 'weather' },
    params: [
      { model: 'ecmwf_ifs', param: 'wind_u_component_10m' },
      { model: 'ecmwf_ifs', param: 'wind_v_component_10m' },
    ],
    palettes: ['wind-speed'],
  },
];

export function getLayerCatalog(): readonly LayerCatalogEntry[] {
  return LAYER_CATALOG;
}
