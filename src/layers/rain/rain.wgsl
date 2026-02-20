// Rain/precipitation layer — procedural SDF particle animation
//
// Two params (both from ecmwf_ifs, advected when wind available):
//   precipitation_type — WMO code: 0=none, 1=rain, 3=freezing rain, 5=snow, 6=wet snow, 7=rain+snow, 8=ice pellets
//   precipitation      — rate in mm/h (continuous 0–50)
//
// Type selects shape+color, rate controls particle density, animation is a deterministic loop.

// ─── Hash functions ──────────────────────────────────────────────────────────

fn rainHash1(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn rainHash2(p: vec2f) -> vec2f {
  return vec2f(
    fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453),
    fract(sin(dot(p, vec2f(269.5, 183.3))) * 43758.5453),
  );
}

// ─── SDF shapes ──────────────────────────────────────────────────────────────

// Raindrop: vertically stretched ellipse
fn sdfDrop(p: vec2f) -> f32 {
  let q = vec2f(p.x * 2.5, p.y);
  return length(q) - 0.12;
}

// Snowflake: 6-fold symmetric star
fn sdfStar6(p: vec2f) -> f32 {
  let angle = atan2(p.y, p.x);
  let r = length(p);
  let petal = cos(angle * 3.0) * 0.04 + 0.09;
  return r - petal;
}

// ─── Type classification ─────────────────────────────────────────────────────

fn isSnowType(ptype: f32) -> bool {
  // WMO 5=snow, 6=wet snow, 7=rain+snow
  return ptype > 4.5 && ptype < 7.5;
}

// ─── Type → color from palette ───────────────────────────────────────────────

fn precipTypeColor(ptype: f32) -> vec3f {
  let range = getLayerPaletteRange(LAYER_RAIN);
  let t = clamp((ptype - range.x) / (range.y - range.x), 0.0, 1.0);
  return samplePalette(t, getLayerPaletteIndex(LAYER_RAIN)).rgb;
}

// ─── Particle system ─────────────────────────────────────────────────────────

// Returns vec2f(sdf, fadeAlpha). sdf > 0 = outside shape, fadeAlpha = brightness.
fn rainParticle(lat: f32, lon: f32, ptype: f32, rate: f32) -> vec2f {
  // Zoom: derive from camera distance (default 3.2 earth radii)
  let camDist = length(u.eyePosition);
  let zoom = 3.2 / camDist;
  let gridSize = u.rainGridSize * zoom;

  // Reduced-longitude grid (pole-safe, same principle as O1280)
  let latIdx = floor(lat * gridSize / COMMON_PI);
  let lonCells = max(floor(gridSize * cos(lat)), 1.0);
  let lonIdx = floor(lon * lonCells / COMMON_TAU);
  let cellId = vec2f(lonIdx, latIdx);
  let cellUV = vec2f(fract(lon * lonCells / COMMON_TAU), fract(lat * gridSize / COMMON_PI));

  // Density: fixed per cell, rate threshold
  let maxRate = 50.0;
  let normalizedRate = sqrt(clamp(rate / maxRate, 0.0, 1.0));
  let cellActive = rainHash1(cellId * 271.0) < normalizedRate;
  if (!cellActive) { return vec2f(1.0, 0.0); }

  // Fade duration per type: snow slower, rain faster
  let snow = isSnowType(ptype);
  let fadeDuration = select(u.rainFadeDuration, u.rainFadeDuration * 2.0, snow);

  // Deterministic loop: fixed phase offset, fixed position
  let phase = fract(u.time / fadeDuration + rainHash1(cellId));
  let fadeAlpha = 1.0 - phase;

  // Fixed position within cell (stable across cycles)
  let particlePos = rainHash2(cellId);
  let p = cellUV - particlePos;

  // SDF shape by type
  let sdf = select(sdfDrop(p), sdfStar6(p), snow);
  return vec2f(sdf, fadeAlpha);
}

// ─── Blend ───────────────────────────────────────────────────────────────────

fn blendRain(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getLayerOpacity(LAYER_RAIN);
  let cell = o1280LatLonToCell(lat, lon);
  let ptype = sampleParam_precipitation_type(cell);
  let rate = sampleParam_precipitation(cell);

  if (ptype < 0.5 || rate < 0.01) { return color; }

  let particle = rainParticle(lat, lon, ptype, rate);
  if (particle.x > 0.0) { return color; }  // outside shape

  let typeColor = precipTypeColor(ptype);
  let alpha = particle.y * opacity;

  return vec4f(mix(color.rgb, typeColor, alpha), color.a);
}
