// Param sampler: dew_point_2m (ECMWF IFS O1280, texture-backed)

import package::aurora::shaders::layer_helpers::{isParamReady, sampleTexParam};
import constants::PARAM_DEW_POINT_2M;

@group(0) @binding(62) var param_dew_point: texture_2d<f32>;

fn sampleParam_dew_point_2m(cell: u32) -> f32 {
  if (!isParamReady(PARAM_DEW_POINT_2M)) { return 0.0; }
  return sampleTexParam(param_dew_point, PARAM_DEW_POINT_2M, cell);
}
