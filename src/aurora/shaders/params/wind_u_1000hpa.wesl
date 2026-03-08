// Param sampler: wind_u_component_1000hPa (NCEP GFS 0.25deg, lat/lon grid)
// Combined buffer: [u_t0, v_t0, u_t1, v_t1] — shared with wind_v_component_1000hPa

import package::aurora::shaders::layer_helpers::{isParamReady, getParamLerp, getParamSize};
import package::aurora::shaders::common::{COMMON_PI, COMMON_TAU};
import constants::PARAM_WIND_U_COMPONENT_1000HPA;

@group(0) @binding(53) var<storage, read> param_wind_uv_1000hPa: array<f32>;

fn sampleParam_wind_u_component_1000hPa(lat: f32, lon: f32) -> f32 {
  if (!isParamReady(PARAM_WIND_U_COMPONENT_1000HPA)) { return 0.0; }
  let latF = (COMMON_PI * 0.5 - lat) * (720.0 / COMMON_PI);
  let lonWrap = lon - floor(lon / COMMON_TAU) * COMMON_TAU;
  let lonF = lonWrap * (1440.0 / COMMON_TAU);
  let latIdx = clamp(u32(latF), 0u, 720u);
  let lonIdx = u32(lonF) % 1440u;
  let cell = latIdx * 1440u + lonIdx;
  let gp = getParamSize(PARAM_WIND_U_COMPONENT_1000HPA);
  let v0 = param_wind_uv_1000hPa[cell];             // u_t0: offset 0
  let v1 = param_wind_uv_1000hPa[cell + 2u * gp];   // u_t1: offset 2*gridPoints
  let lerp = getParamLerp(PARAM_WIND_U_COMPONENT_1000HPA);
  return select(v0, mix(v0, v1, lerp), lerp >= 0.0);
}
