// Param sampler: wind_u_component_10m (ECMWF IFS O1280, cell-based)

import package::aurora::shaders::layer_helpers::{isParamReady, getParamLerp, getParamSize};
import constants::PARAM_WIND_U_COMPONENT_10M;

@group(0) @binding(57) var<storage, read> param_wind_u_component_10m: array<f32>;

fn sampleParam_wind_u_component_10m(cell: u32) -> f32 {
  if (!isParamReady(PARAM_WIND_U_COMPONENT_10M)) { return 0.0; }
  let v0 = param_wind_u_component_10m[cell];
  let v1 = param_wind_u_component_10m[cell + getParamSize(PARAM_WIND_U_COMPONENT_10M)];
  let lerp = getParamLerp(PARAM_WIND_U_COMPONENT_10M);
  return select(v0, mix(v0, v1, lerp), lerp >= 0.0);
}
