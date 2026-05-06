import { defineLayer, withType, withUI, withBlend, withRender, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('earth',
  withType('decoration'),
  withUI('Earth', 'Earth', 'celestial'),
  withBlend('blendBasemap'),
  withRender({
    pass: 'surface',
    order: 0,
  }),
  asBuiltIn(),
);
