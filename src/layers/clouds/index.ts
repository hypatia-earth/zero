import { defineLayer, withType, withUI, withParams, withAdvection, withBlend, withRender, withConfig, asBuiltIn } from '../../services/layer/builder';
import { U } from '../../aurora/globe-uniforms';

export const layer = defineLayer('clouds',
  withType('texture'),
  withUI('Clouds', 'Clouds', 'weather'),
  withParams(
    { model: 'ecmwf_ifs', param: 'cloud_cover' },
  ),
  withParams(
    { model: 'ncep_gfs025', param: 'wind_u_component_1000hPa' },
    { model: 'ncep_gfs025', param: 'wind_v_component_1000hPa' },
  ),
  withAdvection({
    uParam: { model: 'ncep_gfs025', param: 'wind_u_component_1000hPa' },
    vParam: { model: 'ncep_gfs025', param: 'wind_v_component_1000hPa' },
    targets: [
      { model: 'ecmwf_ifs', param: 'cloud_cover' },
    ],
  }),
  withConfig({
    brightness:      { value: 0.85, type: 'f32', pos: U.cloudsBrightness },
    shadowStrength:  { value: 0.8,  type: 'f32', pos: U.cloudsShadowStrength },
    edgeBrightness:  { value: 0.25, type: 'f32', pos: U.cloudsEdgeBrightness },
    coverageMin:     { value: 18.0, type: 'f32', pos: U.cloudsCoverageMin },
    noiseStrength:   { value: 0.2,  type: 'f32', pos: U.cloudsNoiseStrength },
    noiseSpeed:      { value: 0.3,  type: 'f32', pos: U.cloudsNoiseSpeed },
    warmthTint:      { value: 0.6,  type: 'f32', pos: U.cloudsWarmthTint },
    edgeSteps:       { value: 3.0,  type: 'f32', pos: U.cloudsEdgeSteps },
  }),
  withBlend('blendClouds'),
  withRender({ pass: 'surface', order: 30 }),
  asBuiltIn(),
);
