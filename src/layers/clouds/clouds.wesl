// Cloud layer — data-driven cloud visualization with sun-edge shading
//
// Param: cloud_cover (0-100%, advected by NCEP GFS wind)
// Sun-edge detection: 2 neighbor samples along projected sun direction
// Interior texture: 3-octave Perlin noise advected by wind

import package::aurora::shaders::layer_helpers::{u, getLayerOpacity, isLayerDataReady};
import package::aurora::shaders::projection_o1280::o1280LatLonToCell;
import package::aurora::shaders::params::cloud_cover::sampleParam_cloud_cover;
import package::aurora::shaders::params::wind_u_1000hpa::sampleParam_wind_u_component_1000hPa;
import package::aurora::shaders::params::wind_v_1000hpa::sampleParam_wind_v_component_1000hPa;
import constants::LAYER_CLOUDS;

// ─── Constants ─────────────────────────────────────────────────────────────────

const CLOUD_EDGE_STEP: f32 = 0.0014;        // ~9 km (one O1280 cell spacing)
const CLOUD_GOLDEN_ELEV: f32 = 0.15;        // sun elevation threshold for warm tint
const CLOUD_GOLDEN_TINT: vec3f = vec3f(1.0, 0.85, 0.6);

// Noise scales (spatial structure — not tunable)
const CLOUD_NOISE_S1: f32 = 80.0;           // ~200 km features
const CLOUD_NOISE_S2: f32 = 160.0;          // ~100 km features
const CLOUD_NOISE_S3: f32 = 320.0;          // ~50 km features

// ─── Perlin noise (2D, gradient-based) ─────────────────────────────────────────

fn cloudHash2(p: vec2f) -> vec2f {
  let k = vec2f(0.3183099, 0.3678794);
  var q = p * k + k.yx;
  q = fract(q) * 2.0 - 1.0;
  return vec2f(
    fract(16.0 * k.x * fract(q.x * q.y * (q.x + q.y))),
    fract(16.0 * k.y * fract(q.x * q.y * (q.x + q.y) + 0.127))
  ) * 2.0 - 1.0;
}

fn cloudNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);  // smoothstep

  let a = dot(cloudHash2(i + vec2f(0.0, 0.0)), f - vec2f(0.0, 0.0));
  let b = dot(cloudHash2(i + vec2f(1.0, 0.0)), f - vec2f(1.0, 0.0));
  let c = dot(cloudHash2(i + vec2f(0.0, 1.0)), f - vec2f(0.0, 1.0));
  let d = dot(cloudHash2(i + vec2f(1.0, 1.0)), f - vec2f(1.0, 1.0));

  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

// ─── Blend ─────────────────────────────────────────────────────────────────────

fn blendClouds(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (!isLayerDataReady(LAYER_CLOUDS)) { return color; }
  let opacity = getLayerOpacity(LAYER_CLOUDS);

  let coverage = sampleParam_cloud_cover(o1280LatLonToCell(lat, lon));
  if (coverage < u.cloudsCoverageMin) { return color; }

  let thickness = coverage * 0.01;  // 0..1

  // Cloud base color (slightly blue-tinted white)
  let b = u.cloudsBrightness;
  let cloudBase = vec3f(b, b + 0.01, b + 0.03);

  // ── Sun-edge detection ──────────────────────────────────────────────────
  let normal = normalize(vec3f(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon)));

  // Project sun direction onto surface tangent plane
  let sunFlat = u.sunDirection - normal * dot(u.sunDirection, normal);
  let sunLen = length(sunFlat);
  // Near poles or when sun is directly overhead, skip edge detection
  if (sunLen < 0.001) {
    let alpha = thickness * opacity;
    return vec4f(mix(color.rgb, cloudBase, alpha), color.a);
  }
  let sunTangent = sunFlat / sunLen;

  // Step in lat/lon along sun tangent direction
  let cosLat = cos(lat);
  let stepLat = sunTangent.y * CLOUD_EDGE_STEP;
  let stepLon = (sunTangent.x * cos(lon) + sunTangent.z * sin(lon))
                / max(cosLat, 0.01) * CLOUD_EDGE_STEP;

  // Multi-step edge detection: find distance to nearest empty cell (0 = at edge)
  // sunDist: cells to empty toward sun, shadowDist: cells to empty away from sun
  let steps = u32(u.cloudsEdgeSteps);
  var sunDist = steps;     // max = fully interior on sun side
  var shadowDist = steps;  // max = fully interior on shadow side
  for (var i = 1u; i <= 5u; i++) {
    if (i > steps) { break; }
    let fi = f32(i);
    if (sunDist == steps) {
      let s = sampleParam_cloud_cover(o1280LatLonToCell(lat + stepLat * fi, lon + stepLon * fi));
      if (s < u.cloudsCoverageMin) { sunDist = i - 1u; }
    }
    if (shadowDist == steps) {
      let s = sampleParam_cloud_cover(o1280LatLonToCell(lat - stepLat * fi, lon - stepLon * fi));
      if (s < u.cloudsCoverageMin) { shadowDist = i - 1u; }
    }
  }

  // ── Lighting ────────────────────────────────────────────────────────────
  let sunDot = dot(normal, u.sunDirection);
  var cloudColor = cloudBase;
  let maxSteps = f32(steps);

  if (sunDist < steps && shadowDist == steps) {
    // Sun-facing edge: gradient falloff from edge inward
    let edgeFactor = 1.0 - f32(sunDist) / maxSteps;  // 1 at edge, 0 at interior
    let warmth = smoothstep(CLOUD_GOLDEN_ELEV, 0.0, u.sunDirection.y) * u.cloudsWarmthTint;
    let brightTint = mix(vec3f(1.0), CLOUD_GOLDEN_TINT, warmth);
    cloudColor = mix(cloudBase, cloudBase * brightTint * (1.0 + u.cloudsEdgeBrightness * sunDot), edgeFactor);
  } else if (shadowDist < steps && sunDist == steps) {
    // Shadow edge: gradient falloff from edge inward
    let edgeFactor = 1.0 - f32(shadowDist) / maxSteps;
    cloudColor = mix(cloudBase, cloudBase * u.cloudsShadowStrength, edgeFactor);
  }
  // else: deep interior or isolated → default cloudBase

  // ── Perlin noise (interior texture) ─────────────────────────────────────
  // Wind direction gives drift orientation, sin(time) keeps offset bounded
  let windU = sampleParam_wind_u_component_1000hPa(lat, lon);
  let windV = sampleParam_wind_v_component_1000hPa(lat, lon);
  let windLen = max(length(vec2f(windU, windV)), 0.01);
  let windDir = vec2f(windU, windV) / windLen;
  let drift = u.time * u.cloudsNoiseSpeed * 0.01;
  let noiseCoord = vec2f(lon, lat) + windDir * drift;

  let n1 = cloudNoise(noiseCoord * CLOUD_NOISE_S1);
  let n2 = cloudNoise(noiseCoord * CLOUD_NOISE_S2) * 0.5;
  let n3 = cloudNoise(noiseCoord * CLOUD_NOISE_S3) * 0.25;
  let noiseVal = (n1 + n2 + n3) / 1.75;  // normalized ~[-1, 1]

  // Modulate brightness
  cloudColor *= 1.0 + noiseVal * u.cloudsNoiseStrength;

  // ── Limb darkening (longer optical path at grazing angles) ──────────────
  let viewDir = normalize(u.eyePosition - normal);
  let viewDot = max(dot(normal, normalize(viewDir)), 0.001);
  let limbFactor = min(1.0 / viewDot, 3.0);  // cap to avoid extreme values
  let limbBoost = mix(1.0, limbFactor, 0.15);  // subtle effect

  // ── Final blend ─────────────────────────────────────────────────────────
  let alpha = thickness * opacity * limbBoost;
  return vec4f(mix(color.rgb, cloudColor, clamp(alpha, 0.0, 1.0)), color.a);
}
