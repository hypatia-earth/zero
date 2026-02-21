import { defineLayer, withType, withUI, withParams, withSlabs, withOptions, withPalettes, withBlend, withRender, withShader, asBuiltIn } from '../../services/layer/builder';
import shaderCode from './temp.wgsl?raw';

export const layer = defineLayer('temp',
  withType('texture'),
  withUI('Temperature', 'Temperature', 'weather'),
  withParams({ model: 'ecmwf_ifs', param: 'temperature_2m' }),
  withSlabs([
    { name: 'data', sizeMB: 26 },
  ]),
  withPalettes(
    'temp-classic',
    'temp-hypatia',
    'simple-gradient',
  ),
  withOptions([
    'temp.enabled',
    'temp.opacity',
    'temp.palette',
  ]),
  withBlend('blendTemp'),
  withShader('main', shaderCode),
  withRender({
    pass: 'surface',
    order: 10,
  }),
  asBuiltIn(),
);
