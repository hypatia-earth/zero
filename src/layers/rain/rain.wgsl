// Rain/precipitation layer — procedural SDF particle animation
//
// Single param: precipitation_type (WMO code, advected by wind)
// Type selects shape+color, density is uniform from config.

// ─── Hash ───────────────────────────────────────────────────────────────────

fn rainHash1(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn rainHash2(p: vec2f) -> vec2f {
  return vec2f(
    fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453),
    fract(sin(dot(p, vec2f(269.5, 183.3))) * 43758.5453),
  );
}

// ─── SDF (unit radius, < 0 = inside) ───────────────────────────────────────

fn sdfDiamond(p: vec2f) -> f32 {
  let q = abs(p);
  return (q.x + q.y) - 1.0;
}

// ─── Color per WMO code ─────────────────────────────────────────────────────

fn precipTypeColor(ptype: f32) -> vec3f {
  let code = u32(ptype + 0.5);
  switch code {
    case 1u: { return vec3f(0.7, 0.85, 1.0); }    // rain
    case 3u: { return vec3f(0.6, 0.8, 0.95); }     // freezing rain
    case 5u: { return vec3f(1.0, 1.0, 1.0); }      // snow
    case 6u: { return vec3f(0.9, 0.92, 0.95); }    // wet snow
    case 7u: { return vec3f(0.85, 0.9, 0.95); }    // sleet
    case 8u: { return vec3f(0.8, 0.85, 0.95); }    // ice pellets
    default: { return vec3f(1.0, 0.0, 0.0); }      // unknown → red
  }
}

// ─── Blend ──────────────────────────────────────────────────────────────────

fn blendRain(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getLayerOpacity(LAYER_RAIN);

  // Globe screen size (same formula as TS: asin(1/d) * height / fov)
  let camDist = length(u.eyePosition);
  let fov = 2.0 * atan(u.tanFov);
  let globeRadiusPx = asin(1.0 / camDist) * u.resolution.y / fov;

  // Grid: square cells on sphere surface
  let cellSidePx = 1.0 / sqrt(u.rainDensity);
  let gridSize = 2.0 * globeRadiusPx / cellSidePx;
  let latIdx = floor(lat * gridSize / COMMON_PI);
  let lonCells = max(floor(2.0 * gridSize * cos(lat)), 1.0);
  let lonIdx = floor(lon * lonCells / COMMON_TAU);
  let cellId = vec2f(lonIdx, latIdx);
  let cellUV = vec2f(
    fract(lon * lonCells / COMMON_TAU),
    fract(lat * gridSize / COMMON_PI),
  );

  // Particle SDF — constrain position so diamond fits within cell
  let r = u.rainSizePx / cellSidePx;
  let particlePos = rainHash2(cellId) * (1.0 - 2.0 * r) + r;
  let p = cellUV - particlePos;
  let sdf = sdfDiamond(p / r);
  if (sdf > 0.0) { return color; }

  // Sample ptype at cell center (not per pixel) to avoid O1280 grid clipping
  let cellCenterLat = (latIdx + particlePos.y) * COMMON_PI / gridSize;
  let cellCenterLon = (lonIdx + particlePos.x) * COMMON_TAU / lonCells;
  let ptype = sampleParam_precipitation_type(cellCenterLat, cellCenterLon);
  if (ptype < 0.5) { return color; }

  // Fade loop
  let phase = fract(u.time / u.rainFadeDuration + rainHash1(cellId));
  let fadeAlpha = 1.0 - phase;

  let typeColor = precipTypeColor(ptype);
  let alpha = fadeAlpha * opacity;
  return vec4f(mix(color.rgb, typeColor, alpha), color.a);
}
