import { defineLayer, withType, withUI, withOptions, withBlend, withPost, withRender, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('sun',
  withType('decoration'),
  withUI('Sun', 'Sun', 'celestial'),
  withOptions(['sun.enabled', 'sun.opacity']),
  withBlend('blendSun'),
  withPost('postSun'),
  withRender({ pass: 'surface', order: 100 }),
  asBuiltIn(),
);
