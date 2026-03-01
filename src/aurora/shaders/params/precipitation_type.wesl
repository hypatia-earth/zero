// Param sampler: precipitation_type (ECMWF IFS O1280, advected, categorical)

import package::aurora::shaders::layer_helpers::{isParamReady, getParamLerp, getParamSize, getParamDt};
import package::aurora::shaders::projection_o1280::o1280LatLonToCell;
import package::aurora::shaders::params::wind_u_1000hpa::sampleParam_wind_u_component_1000hPa;
import package::aurora::shaders::params::wind_v_1000hpa::sampleParam_wind_v_component_1000hPa;
import constants::PARAM_PRECIPITATION_TYPE;

@group(0) @binding(52) var<storage, read> param_precipitation_type: array<f32>;

fn sampleParam_precipitation_type(lat: f32, lon: f32) -> f32 {
  if (!isParamReady(PARAM_PRECIPITATION_TYPE)) { return 0.0; }
  let lerp = getParamLerp(PARAM_PRECIPITATION_TYPE);
  let size = getParamSize(PARAM_PRECIPITATION_TYPE);
  let windU = sampleParam_wind_u_component_1000hPa(lat, lon);
  let windV = sampleParam_wind_v_component_1000hPa(lat, lon);
  let dt = getParamDt(PARAM_PRECIPITATION_TYPE);
  let R = 6371000.0;
  let cosLat = max(cos(lat), 0.01);
  let dlat = (windV * dt) / R;
  let dlon = (windU * dt) / (R * cosLat);
  let cell0 = o1280LatLonToCell(lat - dlat * lerp, lon - dlon * lerp);
  let v0 = param_precipitation_type[cell0];
  let cell1 = o1280LatLonToCell(lat + dlat * (1.0 - lerp), lon + dlon * (1.0 - lerp));
  let v1 = param_precipitation_type[cell1 + size];
  return select(v0, v1, lerp >= 0.5);
}

// Categorical pair sampler: returns (v0, v1, lerp) for crossfade
fn sampleParamPair_precipitation_type(lat: f32, lon: f32) -> vec3f {
  if (!isParamReady(PARAM_PRECIPITATION_TYPE)) { return vec3f(0.0); }
  let lerp = getParamLerp(PARAM_PRECIPITATION_TYPE);
  let size = getParamSize(PARAM_PRECIPITATION_TYPE);
  let windU = sampleParam_wind_u_component_1000hPa(lat, lon);
  let windV = sampleParam_wind_v_component_1000hPa(lat, lon);
  let dt = getParamDt(PARAM_PRECIPITATION_TYPE);
  let R = 6371000.0;
  let cosLat = max(cos(lat), 0.01);
  let dlat = (windV * dt) / R;
  let dlon = (windU * dt) / (R * cosLat);
  let cell0 = o1280LatLonToCell(lat - dlat * lerp, lon - dlon * lerp);
  let v0 = param_precipitation_type[cell0];
  let cell1 = o1280LatLonToCell(lat + dlat * (1.0 - lerp), lon + dlon * (1.0 - lerp));
  let v1 = param_precipitation_type[cell1 + size];
  return vec3f(v0, v1, lerp);
}
