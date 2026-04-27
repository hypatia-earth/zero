// Wet Bulb stub layer — validates mixed storage+texture access in surface pass
// Reads temperature_2m (storage, binding 50) and dew_point_2m (texture, binding 62)

import package::aurora::shaders::layer_helpers::{getLayerOpacity, getLayerPaletteRange, getLayerPaletteIndex};
import package::aurora::shaders::projection_o1280::o1280LatLonToCell;
import package::aurora::shaders::palette::samplePalette;
import package::aurora::shaders::params::temperature_2m::sampleParam_temperature_2m;
import package::aurora::shaders::params::dew_point_2m::sampleParam_dew_point_2m;
import constants::LAYER_WET_BULB;

// Simplified wet-bulb approximation (Stull 2011)
fn wetBulb(tempC: f32, dewC: f32) -> f32 {
  let rh = 100.0 - 5.0 * (tempC - dewC);
  let rhClamped = clamp(rh, 0.0, 100.0);
  return tempC * atan(0.151977 * sqrt(rhClamped + 8.313659))
    + atan(tempC + rhClamped)
    - atan(rhClamped - 1.676331)
    + 0.00391838 * pow(rhClamped, 1.5) * atan(0.023101 * rhClamped)
    - 4.686035;
}

fn blendWetBulb(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getLayerOpacity(LAYER_WET_BULB);
  let cell = o1280LatLonToCell(lat, lon);
  let tempC = sampleParam_temperature_2m(cell);
  let dewC = sampleParam_dew_point_2m(cell);
  if (tempC < -100.0 || tempC > 100.0) { return color; }
  let wb = wetBulb(tempC, dewC);
  let range = getLayerPaletteRange(LAYER_WET_BULB);
  let t = clamp((wb - range.x) / (range.y - range.x), 0.0, 1.0);
  let wbColor = samplePalette(t, getLayerPaletteIndex(LAYER_WET_BULB, 0u));
  let blendAlpha = opacity * wbColor.a;
  return vec4f(mix(color.rgb, wbColor.rgb, blendAlpha), color.a);
}
