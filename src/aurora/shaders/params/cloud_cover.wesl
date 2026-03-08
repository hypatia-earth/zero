// Param sampler: cloud_cover (ECMWF IFS O1280, cell-based)

import package::aurora::shaders::layer_helpers::{isParamReady, getParamLerp, getParamSize};
import constants::PARAM_CLOUD_COVER;

@group(0) @binding(55) var<storage, read> param_cloud_cover: array<f32>;

fn sampleParam_cloud_cover(cell: u32) -> f32 {
  if (!isParamReady(PARAM_CLOUD_COVER)) { return 0.0; }
  let v0 = param_cloud_cover[cell];
  let v1 = param_cloud_cover[cell + getParamSize(PARAM_CLOUD_COVER)];
  let lerp = getParamLerp(PARAM_CLOUD_COVER);
  return select(v0, mix(v0, v1, lerp), lerp >= 0.0);
}
