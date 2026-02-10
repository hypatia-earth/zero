import { defineLayer, withType, withOptions, withBlend, withRender, asBuiltIn } from '../../render/layer-builder';

export const layer = defineLayer('earth',
  withType('decoration'),
  withOptions(['earth.enabled', 'earth.opacity']),
  withBlend('blendBasemap'),
  withRender({ pass: 'surface', order: 0 }),
  asBuiltIn(),
);
