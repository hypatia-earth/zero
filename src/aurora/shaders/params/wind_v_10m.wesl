// Param sampler: wind_v_component_10m (ECMWF IFS O1280, cell-based)
// Reads from combined buffer declared in wind_u_10m.wesl

import package::aurora::shaders::layer_helpers::{isParamReady, getParamLerp, getParamSize};
import package::aurora::shaders::params::wind_u_10m::param_wind_uv_10m;
import constants::PARAM_WIND_V_COMPONENT_10M;

fn sampleParam_wind_v_component_10m(cell: u32) -> f32 {
  if (!isParamReady(PARAM_WIND_V_COMPONENT_10M)) { return 0.0; }
  let gp = getParamSize(PARAM_WIND_V_COMPONENT_10M);
  let v0 = param_wind_uv_10m[cell + gp];         // v_t0: offset gridPoints
  let v1 = param_wind_uv_10m[cell + 3u * gp];    // v_t1: offset 3*gridPoints
  let lerp = getParamLerp(PARAM_WIND_V_COMPONENT_10M);
  return select(v0, mix(v0, v1, lerp), lerp >= 0.0);
}
