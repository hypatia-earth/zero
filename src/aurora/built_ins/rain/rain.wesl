// Rain/precipitation layer — procedural SDF particle animation
//
// Params: snowfall_water_equivalent (mm), precipitation (mm accumulation)
// Both advected by wind. Snow fraction (snowfall/precip) selects shape, rate drives palette color+alpha.

import package::aurora::shaders::layer_helpers::{u, getLayerOpacity, isLayerDataReady, getLayerPaletteIndex, getParamDt};
import package::aurora::shaders::common::{COMMON_PI, COMMON_TAU};
import package::aurora::shaders::palette::samplePalette;
import constants::{LAYER_RAIN, PARAM_PRECIPITATION};
import package::aurora::shaders::params::snowfall_water_equivalent::sampleParam_snowfall_water_equivalent;
import package::aurora::shaders::params::precipitation::sampleParam_precipitation;

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

fn sdfDrop(p: vec2f) -> f32 {
  // Round bottom, pointy top: squeeze x progressively above center
  let squeeze = 1.0 + max(p.y, 0.0) * 1.5;
  return length(vec2f(p.x * squeeze / 0.75, p.y)) - 1.0;
}

fn sdfStar6(p: vec2f) -> f32 {
  let angle = atan2(p.y, p.x);
  let r = length(p);
  let petal = abs(cos(angle * 3.0)) * 0.6 + 0.4;
  return r - petal;
}

// ─── Blend ──────────────────────────────────────────────────────────────────

fn blendRain(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (!isLayerDataReady(LAYER_RAIN)) { return color; }
  let opacity = getLayerOpacity(LAYER_RAIN);

  // Fixed grid from default zoom (particles anchored to globe surface)
  let fov = 2.0 * atan(u.tanFov);
  let camDist = length(u.eyePosition);
  let refRadiusPx = u.globeRadiusPx * asin(1.0 / 3.2) / asin(1.0 / camDist);
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

  // Sample at particle center (not per pixel) to avoid O1280 grid clipping
  let cellCenterLat = (latIdx + particlePos.y) * COMMON_PI / gridSize;
  let cellCenterLon = (lonIdx + particlePos.x) * COMMON_TAU / lonCells;
  let precip = sampleParam_precipitation(cellCenterLat, cellCenterLon);
  if (precip <= 0.0) { return color; }
  let snowfall = sampleParam_snowfall_water_equivalent(cellCenterLat, cellCenterLon);

  // Snow fraction: threshold at 0.5 — either snow or rain, no blend
  let isSnow = snowfall >= precip * 0.5;
  let sdf = select(sdfDrop(pn), sdfStar6(pn), isSnow);
  if (sdf > 0.0) { return color; }

  // Fade loop — reduced range so particles never vanish (avoids pop-in flicker)
  let phase = fract(u.rainAnimTime / u.rainFadeDuration + rainHash1(cellId));
  let fadeAlpha = 0.5 + 0.5 * (1.0 - phase);

  // Rate normalization: accumulation (mm) → mm/h using param slot spacing
  let dtHours = max(getParamDt(PARAM_PRECIPITATION) / 3600.0, 1.0);
  let rateMmh = precip / dtHours;

  // Palette: wet (slot 0) for rain, frozen (slot 1) for snow
  let paletteIdx = select(getLayerPaletteIndex(LAYER_RAIN, 0u), getLayerPaletteIndex(LAYER_RAIN, 1u), isSnow);
  let t = sqrt(clamp(rateMmh / 50.0, 0.0, 1.0));
  let pc = samplePalette(t, paletteIdx);

  // Smooth fade near precipitation threshold (avoids hard pop at rainMinMm boundary)
  let precipFade = smoothstep(0.0, u.rainMinMm, precip);

  // Palette provides color + intensity alpha; combine with fade and layer opacity
  let alpha = pc.a * fadeAlpha * opacity * precipFade;
  return vec4f(mix(color.rgb, pc.rgb, alpha), color.a);
}
