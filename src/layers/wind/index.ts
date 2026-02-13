export { WindLayer } from './wind-layer';
export { createWindPalette } from './wind-palette';

import { defineLayer, withUI, withParams, withSlabs, withOptions, withCompute, withRender, asBuiltIn } from '../../render/layer-builder';

export const layer = defineLayer('wind',
  withUI('Wind', 'Wind', 'weather'),
  withParams(['wind_u_component_10m', 'wind_v_component_10m']),
  withSlabs([{ name: 'u', sizeMB: 26 }, { name: 'v', sizeMB: 26 }]),
  withOptions(['wind.enabled', 'wind.opacity', 'wind.speed']),
  withCompute({ trace: 'time-change' }),
  withRender({ pass: 'geometry', order: 20, topology: 'line-list' }),
  asBuiltIn(),
);
