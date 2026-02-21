export { WindLayer } from './wind-layer';

import { defineLayer, withUI, withParams, withSlabs, withOptions, withPalettes, withCompute, withRender, withConfig, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('wind',
  withUI('Wind', 'Wind', 'weather'),
  withParams(
    { model: 'ecmwf_ifs', param: 'wind_u_component_10m' },
    { model: 'ecmwf_ifs', param: 'wind_v_component_10m' },
  ),
  withSlabs([
    { name: 'u', sizeMB: 26 },
    { name: 'v', sizeMB: 26 },
  ]),
  withPalettes('wind-speed'),
  withConfig({
    snakeLength:     { value: 0.25 },
    lineWidth:       { value: 0.002 },
    segmentsPerLine: { value: 32 },
    stepFactor:      { value: 0.005 },
    radius:          { value: 1.0 },
  }),
  withOptions([
    'wind.enabled',
    'wind.opacity',
    'wind.speed',
  ]),
  withCompute({
    trace: 'time-change',
  }),
  withRender({
    pass: 'geometry',
    order: 20,
    topology: 'line-list',
  }),
  asBuiltIn(),
);
