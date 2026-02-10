import { defineLayer, withType, withOptions, withBlend, withRender, asBuiltIn } from '../../render/layer-builder';

export const layer = defineLayer('grid',
  withType('decoration'),
  withOptions(['grid.enabled', 'grid.opacity']),
  withBlend('blendGrid'),
  withRender({ pass: 'surface', order: 90 }),
  asBuiltIn(),
);
