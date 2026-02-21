import { defineLayer, withType, withUI, withOptions, withBlend, withPost, withRender, withConfig, asBuiltIn } from '../../services/layer/builder';
import { U } from '../../aurora/globe-uniforms';

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
    coreRadius: { value: 0.015, type: 'f32', pos: U.sunCoreRadius },
    glowRadius: { value: 0.12, type: 'f32', pos: U.sunGlowRadius },
    coreColor:  { value: [1.0, 0.7, 0.3], type: 'vec3f', pos: U.sunCoreColor },
    glowColor:  { value: [1.0, 0.6, 0.2], type: 'vec3f', pos: U.sunGlowColor },
  }),
  withRender({
    pass: 'surface',
    order: 100,
  }),
  asBuiltIn(),
);
