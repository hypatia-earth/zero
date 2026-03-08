// Param sampler: pressure_msl (ECMWF IFS O1280, cell-based)

import package::aurora::shaders::layer_helpers::{isParamReady, getParamLerp, getParamSize};
import constants::PARAM_PRESSURE_MSL;

@group(0) @binding(56) var<storage, read> param_pressure_msl: array<f32>;

fn sampleParam_pressure_msl(cell: u32) -> f32 {
  if (!isParamReady(PARAM_PRESSURE_MSL)) { return 0.0; }
  let v0 = param_pressure_msl[cell];
  let v1 = param_pressure_msl[cell + getParamSize(PARAM_PRESSURE_MSL)];
  let lerp = getParamLerp(PARAM_PRESSURE_MSL);
  return select(v0, mix(v0, v1, lerp), lerp >= 0.0);
}
