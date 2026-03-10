// Param sampler: sea_ice_concentration (ECMWF IFS O1280, texture-backed)

import package::aurora::shaders::layer_helpers::{isParamReady, sampleTexParam};
import constants::PARAM_SEA_ICE_CONCENTRATION;

@group(0) @binding(60) var param_sea_ice: texture_2d<f32>;

fn sampleParam_sea_ice_concentration(cell: u32) -> f32 {
  if (!isParamReady(PARAM_SEA_ICE_CONCENTRATION)) { return 0.0; }
  return sampleTexParam(param_sea_ice, PARAM_SEA_ICE_CONCENTRATION, cell);
}
