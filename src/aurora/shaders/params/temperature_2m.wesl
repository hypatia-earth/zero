// Param sampler: temperature_2m (ECMWF IFS O1280, cell-based)

import package::aurora::shaders::layer_helpers::{isParamReady, getParamLerp, getParamSize};
import constants::PARAM_TEMPERATURE_2M;

@group(0) @binding(50) var<storage, read> param_temperature_2m: array<f32>;

fn sampleParam_temperature_2m(cell: u32) -> f32 {
  if (!isParamReady(PARAM_TEMPERATURE_2M)) { return 0.0; }
  let v0 = param_temperature_2m[cell];
  let v1 = param_temperature_2m[cell + getParamSize(PARAM_TEMPERATURE_2M)];
  let lerp = getParamLerp(PARAM_TEMPERATURE_2M);
  return select(v0, mix(v0, v1, lerp), lerp >= 0.0);
}
