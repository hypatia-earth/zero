import { defineLayer, withType, withParams, withOptions, withBlend, withRender, asBuiltIn } from '../../render/layer-builder';

export const layer = defineLayer('rain',
  withType('texture'),
  withParams(['precipitation']),
  withOptions(['rain.enabled', 'rain.opacity']),
  withBlend('blendRain'),
  withRender({ pass: 'surface', order: 20 }),
  asBuiltIn(),
);
