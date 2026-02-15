import { defineLayer, withType, withUI, withOptions, withBlend, withRender, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('graticule',
  withType('decoration'),
  withUI('Grid', 'Grid', 'reference'),
  withOptions(['graticule.enabled', 'graticule.opacity']),
  withBlend('blendGraticule'),
  withRender({ pass: 'surface', order: 90 }),
  asBuiltIn(),
);
