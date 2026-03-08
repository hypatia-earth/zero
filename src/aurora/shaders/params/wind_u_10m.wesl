// Param sampler: wind_u_component_10m (ECMWF IFS O1280, cell-based)
// Combined buffer: [u_t0, v_t0, u_t1, v_t1] — shared with wind_v_component_10m

import package::aurora::shaders::layer_helpers::{isParamReady, getParamLerp, getParamSize};
import constants::PARAM_WIND_U_COMPONENT_10M;

@group(0) @binding(57) var<storage, read> param_wind_uv_10m: array<f32>;

fn sampleParam_wind_u_component_10m(cell: u32) -> f32 {
  if (!isParamReady(PARAM_WIND_U_COMPONENT_10M)) { return 0.0; }
  let gp = getParamSize(PARAM_WIND_U_COMPONENT_10M);
  let v0 = param_wind_uv_10m[cell];             // u_t0: offset 0
  let v1 = param_wind_uv_10m[cell + 2u * gp];   // u_t1: offset 2*gridPoints
  let lerp = getParamLerp(PARAM_WIND_U_COMPONENT_10M);
  return select(v0, mix(v0, v1, lerp), lerp >= 0.0);
}
