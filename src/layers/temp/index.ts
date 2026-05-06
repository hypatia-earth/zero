import { defineLayer, withType, withUI, withParams, withPalettes, withBlend, withRender, withShader, asBuiltIn } from '../../services/layer/builder';
import shaderCode from './temp.wesl?raw';

export const layer = defineLayer('temp',
  withType('texture'),
  withUI('Temperature', 'Temperature', 'weather'),
  withParams({ model: 'ecmwf_ifs', param: 'temperature_2m' }),
  withPalettes(
    'temp-classic',
    'temp-hypatia',
    'simple-gradient',
  ),
  withBlend('blendTemp'),
  withShader('main', shaderCode),
  withRender({
    pass: 'surface',
    order: 10,
  }),
  asBuiltIn(),
);
