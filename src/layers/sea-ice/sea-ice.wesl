// Sea Ice stub layer — validates texture param binding in surface pass

import package::aurora::shaders::layer_helpers::{getLayerOpacity};
import package::aurora::shaders::projection_o1280::o1280LatLonToCell;
import package::aurora::shaders::params::sea_ice::sampleParam_sea_ice_concentration;
import constants::LAYER_SEA_ICE;

fn blendSeaIce(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getLayerOpacity(LAYER_SEA_ICE);
  let cell = o1280LatLonToCell(lat, lon);
  let concentration = sampleParam_sea_ice_concentration(cell);
  if (concentration <= 0.0) { return color; }
  let iceColor = vec3f(0.75, 0.85, 0.95);  // light blue tint
  let blendAlpha = opacity * clamp(concentration, 0.0, 1.0);
  return vec4f(mix(color.rgb, iceColor, blendAlpha), color.a);
}
