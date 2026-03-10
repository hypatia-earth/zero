/**
 * Sea Ice Layer — Stub for texture param binding validation
 *
 * Dev-only layer (not in BUILT_IN_LAYERS). Validates that:
 * - texture_2d<f32> param binding compiles alongside storage params
 * - textureLoad access works in surface fragment shader
 * - Mixed storage+texture bind group layout is valid
 */

import { defineLayer, withType, withUI, withParams, withBlend, withRender, withShader } from '../../services/layer/builder';
import type { TLayer } from '../../config/types';
import shaderCode from './sea-ice.wesl?raw';

export const layer = defineLayer('sea-ice' as TLayer,
  withType('texture'),
  withUI('Sea Ice', 'Sea Ice', 'weather'),
  withParams({ model: 'ecmwf_ifs', param: 'sea_ice_concentration' }),
  withBlend('blendSeaIce'),
  withShader('main', shaderCode),
  withRender({
    pass: 'surface',
    order: 5,
  }),
);
