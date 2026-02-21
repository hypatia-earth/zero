export { PressureLayer } from './pressure-layer';

import { defineLayer, withUI, withParams, withSlabs, withOptions, withPalettes, withCompute, withRender, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('pressure',
  withUI('Pressure', 'Pressure', 'weather'),
  withParams({ model: 'ecmwf_ifs', param: 'pressure_msl' }),
  withSlabs([{ name: 'raw', sizeMB: 26 }]),  // grid buffer created internally by PressureLayer
  withPalettes('pressure-gradient'),
  withOptions(['pressure.enabled', 'pressure.opacity', 'pressure.spacing', 'pressure.smoothing']),
  withCompute({ regrid: 'data-ready', contour: 'time-change' }),
  withRender({ pass: 'geometry', order: 10, topology: 'line-list' }),
  asBuiltIn(),
);
