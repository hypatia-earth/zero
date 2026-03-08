// Param sampler: wind_v_component_1000hPa (NCEP GFS 0.25deg, lat/lon grid)
// Reads from combined buffer declared in wind_u_1000hpa.wesl

import package::aurora::shaders::layer_helpers::{isParamReady, getParamLerp, getParamSize};
import package::aurora::shaders::common::{COMMON_PI, COMMON_TAU};
import package::aurora::shaders::params::wind_u_1000hpa::param_wind_uv_1000hPa;
import constants::PARAM_WIND_V_COMPONENT_1000HPA;

fn sampleParam_wind_v_component_1000hPa(lat: f32, lon: f32) -> f32 {
  if (!isParamReady(PARAM_WIND_V_COMPONENT_1000HPA)) { return 0.0; }
  let latF = (COMMON_PI * 0.5 - lat) * (720.0 / COMMON_PI);
  let lonWrap = lon - floor(lon / COMMON_TAU) * COMMON_TAU;
  let lonF = lonWrap * (1440.0 / COMMON_TAU);
  let latIdx = clamp(u32(latF), 0u, 720u);
  let lonIdx = u32(lonF) % 1440u;
  let cell = latIdx * 1440u + lonIdx;
  let gp = getParamSize(PARAM_WIND_V_COMPONENT_1000HPA);
  let v0 = param_wind_uv_1000hPa[cell + gp];         // v_t0: offset gridPoints
  let v1 = param_wind_uv_1000hPa[cell + 3u * gp];    // v_t1: offset 3*gridPoints
  let lerp = getParamLerp(PARAM_WIND_V_COMPONENT_1000HPA);
  return select(v0, mix(v0, v1, lerp), lerp >= 0.0);
}
