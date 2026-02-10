export { PressureLayer } from './pressure-layer';
export type { PressureResolution, SmoothingAlgorithm } from './pressure-layer';

import { defineLayer, withParams, withOptions, withCompute, withRender, asBuiltIn } from '../../render/layer-builder';

export const layer = defineLayer('pressure',
  withParams(['pressure_msl']),
  withOptions(['pressure.enabled', 'pressure.opacity', 'pressure.spacing', 'pressure.smoothing']),
  withCompute({ regrid: 'data-ready', contour: 'time-change' }),
  withRender({ pass: 'geometry', order: 10, topology: 'line-list' }),
  asBuiltIn(),
);
