export { PressureLayer } from './pressure-layer';
export type { PressureResolution, SmoothingAlgorithm } from './pressure-layer';

import { defineLayer, withUI, withParams, withSlabs, withOptions, withCompute, withRender, asBuiltIn } from '../../render/layer-builder';

export const layer = defineLayer('pressure',
  withUI('Pressure', 'Pressure', 'weather'),
  withParams(['pressure_msl']),
  withSlabs([{ name: 'raw', sizeMB: 26 }]),  // grid buffer created internally by PressureLayer
  withOptions(['pressure.enabled', 'pressure.opacity', 'pressure.spacing', 'pressure.smoothing']),
  withCompute({ regrid: 'data-ready', contour: 'time-change' }),
  withRender({ pass: 'geometry', order: 10, topology: 'line-list' }),
  asBuiltIn(),
);
