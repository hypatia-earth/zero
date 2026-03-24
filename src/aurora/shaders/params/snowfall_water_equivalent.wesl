// Param sampler: snowfall_water_equivalent (ECMWF IFS O1280, advected, continuous)
// Reads from combined buffer declared in precipitation.wesl

import package::aurora::shaders::layer_helpers::{isParamReady, getParamLerp, getParamSize, getParamDt};
import package::aurora::shaders::projection_o1280::o1280LatLonToCell;
import package::aurora::shaders::params::wind_u_1000hpa::sampleParam_wind_u_component_1000hPa;
import package::aurora::shaders::params::wind_v_1000hpa::sampleParam_wind_v_component_1000hPa;
import package::aurora::shaders::params::precipitation::param_precip_packed;
import constants::PARAM_SNOWFALL_WATER_EQUIVALENT;

fn sampleParam_snowfall_water_equivalent(lat: f32, lon: f32) -> f32 {
  if (!isParamReady(PARAM_SNOWFALL_WATER_EQUIVALENT)) { return 0.0; }
  let lerp = getParamLerp(PARAM_SNOWFALL_WATER_EQUIVALENT);
  let gp = getParamSize(PARAM_SNOWFALL_WATER_EQUIVALENT);
  let windU = sampleParam_wind_u_component_1000hPa(lat, lon);
  let windV = sampleParam_wind_v_component_1000hPa(lat, lon);
  let dt = getParamDt(PARAM_SNOWFALL_WATER_EQUIVALENT);
  let R = 6371000.0;
  let cosLat = max(cos(lat), 0.01);
  let dlat = (windV * dt) / R;
  let dlon = (windU * dt) / (R * cosLat);
  let cell0 = o1280LatLonToCell(lat - dlat * lerp, lon - dlon * lerp);
  let v0 = param_precip_packed[cell0 + gp];              // snowfall_t0: offset gridPoints
  let cell1 = o1280LatLonToCell(lat + dlat * (1.0 - lerp), lon + dlon * (1.0 - lerp));
  let v1 = param_precip_packed[cell1 + 3u * gp];         // snowfall_t1: offset 3*gridPoints
  return mix(v0, v1, lerp);
}
