import { defineLayer, withType, withUI, withOptions, withBlend, withRender, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('earth',
  withType('decoration'),
  withUI('Earth', 'Earth', 'celestial'),
  withOptions(['earth.enabled', 'earth.opacity']),
  withBlend('blendBasemap'),
  withRender({ pass: 'surface', order: 0 }),
  asBuiltIn(),
);
