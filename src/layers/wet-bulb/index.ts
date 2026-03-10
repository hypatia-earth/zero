/**
 * Wet Bulb Layer — Stub validating mixed storage+texture param access
 * Reads temperature_2m (storage) + dewpoint_2m (texture) in one blend function.
 * Dev-only layer (not in BUILT_IN_LAYERS).
 */

import { defineLayer, withType, withUI, withParams, withPalettes, withBlend, withRender, withShader } from '../../services/layer/builder';
import type { TLayer } from '../../config/types';
import shaderCode from './wet-bulb.wesl?raw';

export const layer = defineLayer('wet-bulb' as TLayer,
  withType('texture'),
  withUI('Wet Bulb', 'Wet Bulb', 'weather'),
  withParams(
    { model: 'ecmwf_ifs', param: 'temperature_2m' },
    { model: 'ecmwf_ifs', param: 'dewpoint_2m' },
  ),
  withPalettes('simple-gradient'),
  withBlend('blendWetBulb'),
  withShader('main', shaderCode),
  withRender({
    pass: 'surface',
    order: 7,
  }),
);
