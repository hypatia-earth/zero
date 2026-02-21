import { defineLayer, withType, withUI, withParams, withAdvection, withSlabs, withOptions, withPalettes, withBlend, withRender, withConfig, asBuiltIn } from '../../services/layer/builder';
export const layer = defineLayer('rain',
  withType('texture'),
  withUI('Precipitation', 'Precipitation', 'weather'),
  withParams(
    { model: 'ecmwf_ifs', param: 'precipitation_type' },
    { model: 'ecmwf_ifs', param: 'precipitation' },
  ),
  withParams(
    { model: 'ncep_gfs025', param: 'wind_u_component_1000hPa' },
    { model: 'ncep_gfs025', param: 'wind_v_component_1000hPa' },
  ),
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
  withConfig({
    density: 0.16,
    sizePx: 0.5625,
    fadeDuration: 3.0,
    minMm: 0.1,
    colors: {
      rain:            [0.7, 0.85, 1.0],
      freezingRain:    [0.6, 0.8, 0.95],
      snow:            [1.0, 1.0, 1.0],
      wetSnow:         [0.9, 0.92, 0.95],
      sleet:           [0.85, 0.9, 0.95],
      icePellets:      [0.8, 0.85, 0.95],
      freezingDrizzle: [0.75, 0.85, 0.9],
    },
  }),
  withOptions(['rain.enabled', 'rain.opacity']),
  withBlend('blendRain'),
  withRender({ pass: 'surface', order: 20 }),
  asBuiltIn(),
);
