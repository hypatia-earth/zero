// Basemap layer - Earth texture from cubemap

import package::aurora::shaders::layer_helpers::getLayerOpacity;
import constants::LAYER_EARTH;

@group(0) @binding(1) var basemap: texture_cube<f32>;
@group(0) @binding(2) var basemapSampler: sampler;

fn blendBasemap(color: vec4f, hitPoint: vec3f) -> vec4f {
  // Use textureSampleLevel to avoid non-uniform control flow issues
  let texColor = textureSampleLevel(basemap, basemapSampler, hitPoint, 0.0);
  return vec4f(mix(color.rgb, texColor.rgb, getLayerOpacity(LAYER_EARTH)), 1.0);
}
