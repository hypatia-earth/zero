// Rain/precipitation layer — procedural SDF particle animation
//
// Params: precipitation_type (WMO code), precipitation (mm accumulation)
// Both advected by wind. Type selects shape, rate drives palette color+alpha.

import package::aurora::shaders::layer_helpers::{u, getLayerOpacity, isLayerDataReady, getLayerPaletteIndex, getParamDt};
import package::aurora::shaders::common::{COMMON_PI, COMMON_TAU};
import package::aurora::shaders::palette::samplePalette;
import constants::{LAYER_RAIN, PARAM_PRECIPITATION};
// sampleParam_* provided by param_gen virtual library
import param_gen::{sampleParam_precipitation_type, sampleParam_precipitation};

// ─── Hash ───────────────────────────────────────────────────────────────────

fn rainHash1(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn rainHash2(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// ─── SDF (unit radius, < 0 = inside) ───────────────────────────────────────

fn sdfDisk(p: vec2f) -> f32 {
  return length(p) - 1.0;
}

fn sdfDrop(p: vec2f) -> f32 {
  // Round bottom, pointy top: squeeze x progressively above center
  let squeeze = 1.0 + max(p.y, 0.0) * 1.5;
  return length(vec2f(p.x * squeeze / 0.75, p.y)) - 1.0;
}

fn sdfDiamond(p: vec2f) -> f32 {
  let q = abs(p);
  return (q.x + q.y) - 1.0;
}

fn sdfSquare(p: vec2f) -> f32 {
  let d = abs(p);
  return max(d.x, d.y) - 0.8;
}

fn sdfStar6(p: vec2f) -> f32 {
  let angle = atan2(p.y, p.x);
  let r = length(p);
  let petal = abs(cos(angle * 3.0)) * 0.6 + 0.4;
  return r - petal;
}

// ─── Helpers by WMO code ────────────────────────────────────────────────────

fn ptypeSdf(code: u32, pn: vec2f) -> f32 {
  switch code {
    case 1u:       { return sdfDrop(pn); }        // rain
    case 3u, 12u:  { return sdfDrop(pn); }        // freezing rain/drizzle
    case 5u:       { return sdfStar6(pn); }       // snow
    case 6u, 7u:   { return sdfStar6(pn); }       // wet snow, sleet
    case 8u:       { return sdfDiamond(pn); }     // ice pellets
    default:       { return sdfDisk(pn); }        // unknown/0
  }
}

// Wet (liquid) types use LAYER_RAIN slot 0, frozen types use slot 1
fn isFrozenType(code: u32) -> bool {
  return code == 3u || code == 5u || code == 8u || code == 12u;
}

fn ptypePalette(code: u32) -> u32 {
  return select(getLayerPaletteIndex(LAYER_RAIN, 0u), getLayerPaletteIndex(LAYER_RAIN, 1u), isFrozenType(code));
}

// ─── Blend ──────────────────────────────────────────────────────────────────

fn blendRain(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (!isLayerDataReady(LAYER_RAIN)) { return color; }
  let opacity = getLayerOpacity(LAYER_RAIN);

  // Fixed grid from default zoom (particles anchored to globe surface)
  let fov = 2.0 * atan(u.tanFov);
  let refRadiusPx = asin(1.0 / 3.2) * u.resolution.y / fov;
  let cellSidePx = 1.0 / sqrt(u.rainDensity);
  let gridSize = max(floor(2.0 * refRadiusPx / cellSidePx), 1.0);
  let latIdx = floor(lat * gridSize / COMMON_PI);
  let latCenter = (latIdx + 0.5) * COMMON_PI / gridSize;
  let lonCells = max(floor(2.0 * gridSize * cos(latCenter)), 1.0);
  let lonIdx = floor(lon * lonCells / COMMON_TAU);
  let cellId = vec2f(lonIdx, latIdx);
  let cellUV = vec2f(
    fract(lon * lonCells / COMMON_TAU),
    fract(lat * gridSize / COMMON_PI),
  );

  // Particle SDF — constrain position so shape fits within cell
  let r = u.rainSizePx / cellSidePx;
  let particlePos = rainHash2(cellId) * (1.0 - 2.0 * r) + r;
  let p = cellUV - particlePos;
  let pn = p / r;

  // Sample ptype pair at particle center (not per pixel) to avoid O1280 grid clipping
  let cellCenterLat = (latIdx + particlePos.y) * COMMON_PI / gridSize;
  let cellCenterLon = (lonIdx + particlePos.x) * COMMON_TAU / lonCells;
  let ptypePair = sampleParamPair_precipitation_type(cellCenterLat, cellCenterLon);
  let ptype0 = ptypePair.x;
  let ptype1 = ptypePair.y;
  let ptypeLerp = ptypePair.z;
  if (ptype0 < 0.5 && ptype1 < 0.5) { return color; }
  let precip = sampleParam_precipitation(cellCenterLat, cellCenterLon);
  if (precip <= 0.0) { return color; }

  // Crossfade SDF shapes between t0 and t1 types
  // Code 0 = no type data — inherit shape, fade alpha by lerp
  var code0 = u32(ptype0 + 0.5);
  var code1 = u32(ptype1 + 0.5);
  var ptypeAlpha = 1.0;
  if (code0 == 0u && code1 != 0u) { code0 = code1; ptypeAlpha = ptypeLerp; }
  if (code1 == 0u && code0 != 0u) { code1 = code0; ptypeAlpha = 1.0 - ptypeLerp; }
  let sdf = mix(ptypeSdf(code0, pn), ptypeSdf(code1, pn), ptypeLerp);
  if (sdf > 0.0) { return color; }

  // Fade loop — reduced range so particles never vanish (avoids pop-in flicker)
  let phase = fract(u.rainAnimTime / u.rainFadeDuration + rainHash1(cellId));
  let fadeAlpha = 0.5 + 0.5 * (1.0 - phase);

  // Rate normalization: accumulation (mm) → mm/h using param slot spacing
  let dtHours = max(getParamDt(PARAM_PRECIPITATION) / 3600.0, 1.0);
  let rateMmh = precip / dtHours;

  // Crossfade palette colors between t0 and t1 types
  let t = sqrt(clamp(rateMmh / 50.0, 0.0, 1.0));
  let pc0 = samplePalette(t, ptypePalette(code0));
  let pc1 = samplePalette(t, ptypePalette(code1));
  let pc = mix(pc0, pc1, ptypeLerp);

  // Smooth fade near precipitation threshold (avoids hard pop at rainMinMm boundary)
  let precipFade = smoothstep(0.0, u.rainMinMm, precip);

  // Palette provides color + intensity alpha; combine with fade and layer opacity
  let alpha = pc.a * fadeAlpha * opacity * ptypeAlpha * precipFade;
  return vec4f(mix(color.rgb, pc.rgb, alpha), color.a);
}
