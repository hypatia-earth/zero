// Param sampler: precipitation (ECMWF IFS O1280, advected by GFS 1000hPa wind)
// Combined buffer: [precip_t0, precip_type_t0, precip_t1, precip_type_t1] — shared with precipitation_type

import package::aurora::shaders::layer_helpers::{isParamReady, getParamLerp, getParamSize, getParamDt};
import package::aurora::shaders::projection_o1280::o1280LatLonToCell;
import package::aurora::shaders::params::wind_u_1000hpa::sampleParam_wind_u_component_1000hPa;
import package::aurora::shaders::params::wind_v_1000hpa::sampleParam_wind_v_component_1000hPa;
import constants::PARAM_PRECIPITATION;

@group(0) @binding(51) var<storage, read> param_precip_packed: array<f32>;

fn sampleParam_precipitation(lat: f32, lon: f32) -> f32 {
  if (!isParamReady(PARAM_PRECIPITATION)) { return 0.0; }
  let lerp = getParamLerp(PARAM_PRECIPITATION);
  let gp = getParamSize(PARAM_PRECIPITATION);
  let windU = sampleParam_wind_u_component_1000hPa(lat, lon);
  let windV = sampleParam_wind_v_component_1000hPa(lat, lon);
  let dt = getParamDt(PARAM_PRECIPITATION);
  let R = 6371000.0;
  let cosLat = max(cos(lat), 0.01);
  let dlat = (windV * dt) / R;
  let dlon = (windU * dt) / (R * cosLat);
  let cell0 = o1280LatLonToCell(lat - dlat * lerp, lon - dlon * lerp);
  let v0 = param_precip_packed[cell0];                   // precip_t0: offset 0
  let cell1 = o1280LatLonToCell(lat + dlat * (1.0 - lerp), lon + dlon * (1.0 - lerp));
  let v1 = param_precip_packed[cell1 + 2u * gp];         // precip_t1: offset 2*gridPoints
  return mix(v0, v1, lerp);
}
