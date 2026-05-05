import { defineLayer, withType, withUI, withOptions, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('cities',
  withType('decoration'),
  withUI('Cities', 'Cities', 'reference'),
  withOptions([
    'cities.enabled',
    'cities.opacity',
  ]),
  asBuiltIn(),
);
