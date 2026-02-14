import { defineLayer, withType, withUI, withParams, withSlabs, withOptions, withBlend, withRender, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('rain',
  withType('texture'),
  withUI('Precipitation', 'Rain', 'weather'),
  withParams(['precipitation_type']),
  withSlabs([{ name: 'data', sizeMB: 26 }]),
  withOptions(['rain.enabled', 'rain.opacity']),
  withBlend('blendRain'),
  withRender({ pass: 'surface', order: 20 }),
  asBuiltIn(),
);
