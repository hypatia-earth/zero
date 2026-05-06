import { defineLayer, withType, withUI, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('graticule',
  withType('decoration'),
  withUI('Grid', 'Grid', 'reference'),
  asBuiltIn(),
);
