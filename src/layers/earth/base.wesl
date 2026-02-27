// Basemap layer - Earth texture from cubemap

fn blendBasemap(color: vec4f, hitPoint: vec3f) -> vec4f {
  // Use textureSampleLevel to avoid non-uniform control flow issues
  let texColor = textureSampleLevel(basemap, basemapSampler, hitPoint, 0.0);
  return vec4f(mix(color.rgb, texColor.rgb, getLayerOpacity(LAYER_EARTH)), 1.0);
}
