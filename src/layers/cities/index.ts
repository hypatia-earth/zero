import { defineLayer, withType, withUI, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('cities',
  withType('decoration'),
  withUI('Cities', 'Cities', 'reference'),
  asBuiltIn(),
);
