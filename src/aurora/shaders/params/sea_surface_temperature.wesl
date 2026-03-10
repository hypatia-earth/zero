// Param sampler: sea_surface_temperature (ECMWF IFS O1280, texture-backed)

import package::aurora::shaders::layer_helpers::{isParamReady, sampleTexParam};
import constants::PARAM_SEA_SURFACE_TEMPERATURE;

@group(0) @binding(61) var param_sst: texture_2d<f32>;

fn sampleParam_sea_surface_temperature(cell: u32) -> f32 {
  if (!isParamReady(PARAM_SEA_SURFACE_TEMPERATURE)) { return 0.0; }
  return sampleTexParam(param_sst, PARAM_SEA_SURFACE_TEMPERATURE, cell);
}
