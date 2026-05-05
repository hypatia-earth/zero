import { defineLayer, withType, withUI, withOptions, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('graticule',
  withType('decoration'),
  withUI('Grid', 'Grid', 'reference'),
  withOptions([
    'graticule.enabled',
    'graticule.opacity',
    'graticule.fontSize',
    'graticule.lineWidth',
  ]),
  asBuiltIn(),
);
