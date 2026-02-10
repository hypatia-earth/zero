import { defineLayer, withType, withParams, withOptions, withBlend, withRender, asBuiltIn } from '../../render/layer-builder';

export const layer = defineLayer('temp',
  withType('texture'),
  withParams(['temp_2m']),
  withOptions(['temp.enabled', 'temp.opacity', 'temp.palette']),
  withBlend('blendTemp'),
  withRender({ pass: 'surface', order: 10 }),
  asBuiltIn(),
);
