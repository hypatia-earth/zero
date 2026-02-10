export { WindLayer } from './wind-layer';
export { createWindPalette } from './wind-palette';

import { defineLayer, withParams, withOptions, withCompute, withRender, asBuiltIn } from '../../render/layer-builder';

export const layer = defineLayer('wind',
  withParams(['wind_u_10m', 'wind_v_10m']),
  withOptions(['wind.enabled', 'wind.opacity', 'wind.speed']),
  withCompute({ trace: 'time-change' }),
  withRender({ pass: 'geometry', order: 20, topology: 'line-list' }),
  asBuiltIn(),
);
