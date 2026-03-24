import { defineLayer, withType, withUI, withParams, withAdvection, withOptions, withPalettes, withBlend, withRender, withConfig, asBuiltIn } from '../../services/layer/builder';
import { U } from '../../aurora/globe-uniforms';

export const layer = defineLayer('rain',
  withType('texture'),
  withUI('Precipitation', 'Precipitation', 'weather'),
  withParams(
    { model: 'ecmwf_ifs', param: 'snowfall_water_equivalent' },
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
      { model: 'ecmwf_ifs', param: 'snowfall_water_equivalent' },
      { model: 'ecmwf_ifs', param: 'precipitation' },
    ],
  }),
  withPalettes(
    'rain-wet-intensity',
    'rain-frozen-intensity',
  ),
  withConfig({
    density:      { value: 0.16, type: 'f32', pos: U.rainDensity },
    sizePx:       { value: 0.5625, type: 'f32', pos: U.rainSizePx },
    fadeDuration: { value: 3.0, type: 'f32', pos: U.rainFadeDuration },
    minMm:        { value: 0.1, type: 'f32', pos: U.rainMinMm },
    colors: {
      rain:  [0.7, 0.85, 1.0],
      snow:  [1.0, 1.0, 1.0],
    },
  }),
  withOptions([
    'rain.enabled',
    'rain.opacity',
  ]),
  withBlend('blendRain'),
  withRender({
    pass: 'surface',
    order: 20,
  }),
  asBuiltIn(),
);
