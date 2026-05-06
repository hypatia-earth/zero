import { defineLayer, withUI, withParams, withPalettes, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('wind',
  withUI('Wind', 'Wind', 'weather'),
  withParams(
    { model: 'ecmwf_ifs', param: 'wind_u_component_10m' },
    { model: 'ecmwf_ifs', param: 'wind_v_component_10m' },
  ),
  withPalettes('wind-speed'),
  asBuiltIn(),
);
