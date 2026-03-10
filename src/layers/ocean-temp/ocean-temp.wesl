// Ocean Temperature stub layer — validates texture param binding in surface pass

import package::aurora::shaders::layer_helpers::{getLayerOpacity, getLayerPaletteRange, getLayerPaletteIndex};
import package::aurora::shaders::projection_o1280::o1280LatLonToCell;
import package::aurora::shaders::palette::samplePalette;
import package::aurora::shaders::params::sea_surface_temperature::sampleParam_sea_surface_temperature;
import constants::LAYER_OCEAN_TEMP;

fn blendOceanTemp(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getLayerOpacity(LAYER_OCEAN_TEMP);
  let cell = o1280LatLonToCell(lat, lon);
  let tempC = sampleParam_sea_surface_temperature(cell);
  if (tempC < -100.0 || tempC > 100.0) { return color; }
  let range = getLayerPaletteRange(LAYER_OCEAN_TEMP);
  let t = clamp((tempC - range.x) / (range.y - range.x), 0.0, 1.0);
  let sstColor = samplePalette(t, getLayerPaletteIndex(LAYER_OCEAN_TEMP, 0u));
  let blendAlpha = opacity * sstColor.a;
  return vec4f(mix(color.rgb, sstColor.rgb, blendAlpha), color.a);
}
