import { defineLayer, withType, withOptions, withBlend, withPost, withRender, asBuiltIn } from '../../render/layer-builder';

export const layer = defineLayer('sun',
  withType('decoration'),
  withOptions(['sun.enabled', 'sun.opacity']),
  withBlend('blendSun'),
  withPost('postSun'),
  withRender({ pass: 'surface', order: 100 }),
  asBuiltIn(),
);
