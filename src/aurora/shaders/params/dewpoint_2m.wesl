// Param sampler: dewpoint_2m (ECMWF IFS O1280, texture-backed)

import package::aurora::shaders::layer_helpers::{isParamReady, sampleTexParam};
import constants::PARAM_DEWPOINT_2M;

@group(0) @binding(62) var param_dewpoint: texture_2d<f32>;

fn sampleParam_dewpoint_2m(cell: u32) -> f32 {
  if (!isParamReady(PARAM_DEWPOINT_2M)) { return 0.0; }
  return sampleTexParam(param_dewpoint, PARAM_DEWPOINT_2M, cell);
}
