// Cities layer — MSDF text labels on globe surface
// Renders city names from a lookup texture + glyph atlas

import package::aurora::shaders::layer_helpers::{u, getLayerOpacity};
import constants::LAYER_CITIES;

// GPU data structures (must match CPU packing)
struct CityLabel {
  lat: f32,           // radians
  lon: f32,           // radians
  glyphOffset: u32,
  glyphCount: u32,
  fontSize: f32,      // radians (world units)
  labelWidth: f32,    // radians
  labelHeight: f32,   // radians
  opacity: f32,
}

struct Glyph {
  atlasX: f32,
  atlasY: f32,
  atlasW: f32,
  atlasH: f32,
  advance: f32,       // cumulative x offset (normalized to fontSize)
  xOffset: f32,       // glyph offset (normalized)
  yOffset: f32,
  _pad: f32,
}

// Bindings — cities + glyphs packed into single buffer as vec4f pairs
@group(0) @binding(22) var cityLookup: texture_2d<u32>;
@group(0) @binding(23) var<storage, read> cityData: array<vec4f>;
@group(0) @binding(25) var cityFontAtlas: texture_2d<f32>;
@group(0) @binding(26) var cityFontSampler: sampler;

// Accessors — each struct = 2 consecutive vec4f (32 bytes)
fn getCityLabel(index: u32) -> CityLabel {
  let a = cityData[index * 2u];
  let b = cityData[index * 2u + 1u];
  return CityLabel(a.x, a.y, bitcast<u32>(a.z), bitcast<u32>(a.w), b.x, b.y, b.z, b.w);
}

fn getGlyph(index: u32) -> Glyph {
  let base = u.cityGlyphOffset + index * 2u;
  let a = cityData[base];
  let b = cityData[base + 1u];
  return Glyph(a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w);
}

// Atlas dimensions (from inter-regular.json common section)
const ATLAS_WIDTH: f32 = 1506.0;
const ATLAS_HEIGHT: f32 = 1535.0;
const DISTANCE_RANGE: f32 = 4.0;
const FONT_SIZE_NORM: f32 = 42.0;

// MSDF median
fn msdfMedian(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

fn blendCities(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let layerOpacity = getLayerOpacity(LAYER_CITIES);
  if (layerOpacity < 0.01) { return color; }

  // Convert to lookup texture coordinates
  var lonDeg = degrees(lon);
  if (lonDeg < 0.0) { lonDeg += 360.0; }
  let latDeg = degrees(lat);

  let texX = clamp(u32(lonDeg / 360.0 * 2048.0), 0u, 2047u);
  let texY = clamp(u32((90.0 - latDeg) / 180.0 * 1024.0), 0u, 1023u);

  let cityIdx = textureLoad(cityLookup, vec2u(texX, texY), 0).r;
  if (cityIdx == 0u) { return color; }

  let city = getCityLabel(cityIdx - 1u);
  if (city.glyphCount == 0u) { return color; }

  // Compute local position within label bounds (in radians)
  let dLat = lat - city.lat;
  var dLon = lon - city.lon;
  // Wrap longitude difference
  if (dLon > 3.14159) { dLon -= 6.28318; }
  if (dLon < -3.14159) { dLon += 6.28318; }

  // cos(lat) compensation for longitude
  let cosLat = max(cos(lat), 0.01);

  // Indicator: square centered on city position (lat/lon)
  let indicatorHalf = city.fontSize * 0.175;
  let indLonOff = dLon * cosLat;  // longitude offset in world units

  let fontScale = u.cityFontScale;
  if (fontScale < 0.01) {
    // No labels — enlarged indicator
    let bigHalf = indicatorHalf * 3.0;
    if (indLonOff > -bigHalf && indLonOff < bigHalf &&
        dLat > -bigHalf && dLat < bigHalf) {
      let alpha = layerOpacity * city.opacity;
      let cc = vec3f(u.cityColorR, u.cityColorG, u.cityColorB);
      return vec4f(mix(color.rgb, cc, alpha), color.a);
    }
    return color;
  }

  // Small indicator with labels
  let cityColor = vec3f(u.cityColorR, u.cityColorG, u.cityColorB);
  if (indLonOff > -indicatorHalf && indLonOff < indicatorHalf &&
      dLat > -indicatorHalf && dLat < indicatorHalf) {
    let alpha = layerOpacity * city.opacity;
    return vec4f(mix(color.rgb, cityColor, alpha), color.a);
  }

  let scaledFontSize = city.fontSize * fontScale;

  // Label east of indicator, top-aligned with fine-tuned offset
  let nudge = city.fontSize * 0.0875;
  let localX = (dLon * cosLat - indicatorHalf - nudge) / scaledFontSize;
  let localY = (dLat + 0.81 * scaledFontSize - 1.55 * indicatorHalf) / scaledFontSize;

  // Bounds check
  let labelW = city.labelWidth / city.fontSize;
  let labelH = city.labelHeight / city.fontSize;
  if (localX < -0.2 || localX > labelW + 0.2 || localY < -0.4 || localY > labelH + 0.2) {
    return color;
  }

  // Screen-space metrics for MSDF anti-aliasing
  let dist = length(vec3f(
    u.eyePosition.x - cos(lat) * sin(lon),
    u.eyePosition.y - sin(lat),
    u.eyePosition.z - cos(lat) * cos(lon)
  ));
  let worldUnitsPerPixel = (2.0 * u.tanFov * dist) / u.resolution.y;
  let screenPxRange = (scaledFontSize / worldUnitsPerPixel) / DISTANCE_RANGE;

  // Walk glyphs to find which one we're over
  var textAlpha = 0.0;

  for (var i = 0u; i < city.glyphCount; i++) {
    let g = getGlyph(city.glyphOffset + i);

    if (g.atlasW < 0.5 || g.atlasH < 0.5) { continue; } // skip space chars

    // Glyph bounds in label-local coords
    let gx = g.advance + g.xOffset;
    let gy = 1.0 - g.yOffset - g.atlasH / FONT_SIZE_NORM;  // flip Y: atlas is top-down, label is bottom-up
    let gw = g.atlasW / FONT_SIZE_NORM;
    let gh = g.atlasH / FONT_SIZE_NORM;

    // Local UV within glyph [0,1]
    let glyphU = (localX - gx) / gw;
    let glyphV = (localY - gy) / gh;

    if (glyphU < -0.15 || glyphU > 1.15 || glyphV < -0.15 || glyphV > 1.15) { continue; }

    // Atlas UV
    let atlasU = (g.atlasX + clamp(glyphU, 0.0, 1.0) * g.atlasW) / ATLAS_WIDTH;
    let atlasV = (g.atlasY + clamp(1.0 - glyphV, 0.0, 1.0) * g.atlasH) / ATLAS_HEIGHT;

    let msdf = textureSampleLevel(cityFontAtlas, cityFontSampler, vec2f(atlasU, atlasV), 0.0);
    let sd = msdfMedian(msdf.r, msdf.g, msdf.b);
    let screenPxDist = screenPxRange * (sd - 0.5);

    // Fill
    let fill = clamp(screenPxDist + 0.5, 0.0, 1.0);
    textAlpha = max(textAlpha, fill);
  }

  if (textAlpha < 0.01) { return color; }

  let alpha = layerOpacity * city.opacity;
  let result = mix(color.rgb, cityColor, textAlpha * alpha);

  return vec4f(result, color.a);
}
