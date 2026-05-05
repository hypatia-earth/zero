import { defineLayer, withUI, withParams, withOptions, withPalettes, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('pressure',
  withUI('Pressure', 'Pressure', 'weather'),
  withParams({ model: 'ecmwf_ifs', param: 'pressure_msl' }),
  withPalettes('pressure-gradient'),
  withOptions([
    'pressure.enabled',
    'pressure.opacity',
    'pressure.spacing',
    'pressure.smoothing',
  ]),
  asBuiltIn(),
);
