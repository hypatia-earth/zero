/**
 * Ocean Temperature Layer — Stub for texture param binding validation
 * Dev-only layer (not in BUILT_IN_LAYERS).
 */

import { defineLayer, withType, withUI, withParams, withPalettes, withBlend, withRender, withShader } from '../../services/layer/builder';
import type { TLayer } from '../../config/types';
import shaderCode from './ocean-temp.wesl?raw';

export const layer = defineLayer('ocean-temp' as TLayer,
  withType('texture'),
  withUI('Ocean Temp', 'Ocean Temp', 'weather'),
  withParams({ model: 'ecmwf_ifs', param: 'sea_surface_temperature' }),
  withPalettes('simple-gradient'),
  withBlend('blendOceanTemp'),
  withShader('main', shaderCode),
  withRender({
    pass: 'surface',
    order: 6,
  }),
);
