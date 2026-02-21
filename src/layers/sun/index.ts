import { defineLayer, withType, withUI, withOptions, withBlend, withPost, withRender, withConfig, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('sun',
  withType('decoration'),
  withUI('Sun', 'Sun', 'celestial'),
  withOptions([
    'sun.enabled',
    'sun.opacity',
  ]),
  withBlend('blendSun'),
  withPost('postSun'),
  withConfig({
    coreRadius: 0.015,
    glowRadius: 0.12,
    coreColor: [1.0, 0.7, 0.3],
    glowColor: [1.0, 0.6, 0.2],
  }),
  withRender({
    pass: 'surface',
    order: 100,
  }),
  asBuiltIn(),
);
