import { defineLayer, withUI, withParams, withPalettes, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('pressure',
  withUI('Pressure', 'Pressure', 'weather'),
  withParams({ model: 'ecmwf_ifs', param: 'pressure_msl' }),
  withPalettes('pressure-gradient'),
  asBuiltIn(),
);
