import { defineLayer, withType, withParams, withOptions, withBlend, withRender, withShader, asBuiltIn } from '../../render/layer-builder';
import shaderCode from './temp.wgsl?raw';

export const layer = defineLayer('temp',
  withType('texture'),
  withParams(['temp_2m']),
  withOptions(['temp.enabled', 'temp.opacity', 'temp.palette']),
  withBlend('blendTemp'),
  withShader('main', shaderCode),
  withRender({ pass: 'surface', order: 10 }),
  asBuiltIn(),
);
