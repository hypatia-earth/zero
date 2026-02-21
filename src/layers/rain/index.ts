import { defineLayer, withType, withUI, withParams, withAdvection, withSlabs, withOptions, withPalettes, withBlend, withRender, asBuiltIn } from '../../services/layer/builder';
export const layer = defineLayer('rain',
  withType('texture'),
  withUI('Precipitation', 'Precipitation', 'weather'),
  withParams(['precipitation_type', 'precipitation'], 'ecmwf_ifs'),
  withParams(['wind_u_component_1000hPa', 'wind_v_component_1000hPa'], 'ncep_gfs025'),
  withAdvection({
    uParam: { model: 'ncep_gfs025', param: 'wind_u_component_1000hPa' },
    vParam: { model: 'ncep_gfs025', param: 'wind_v_component_1000hPa' },
    targets: [
      { model: 'ecmwf_ifs', param: 'precipitation_type' },
      { model: 'ecmwf_ifs', param: 'precipitation' },
    ],
  }),
  withSlabs([{ name: 'data', sizeMB: 26 }]),
  withPalettes('rain-wet-intensity', 'rain-frozen-intensity'),
  withOptions(['rain.enabled', 'rain.opacity']),
  withBlend('blendRain'),
  withRender({ pass: 'surface', order: 20 }),
  asBuiltIn(),
);
