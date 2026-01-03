// Grid layer - animated lat/lon grid overlay
// Lines are passed as uniforms for LoD animation

const GRID_MAX_LINES: u32 = 80u;

// Grid line data from GridAnimator
// Uses vec4 packing for 16-byte uniform alignment: 20 vec4s = 80 floats
struct GridLines {
  lonDegrees: array<vec4<f32>, 20>,    // longitude line positions (80 floats)
  lonOpacities: array<vec4<f32>, 20>,  // longitude line opacities (80 floats)
  latDegrees: array<vec4<f32>, 20>,    // latitude line positions (80 floats)
  latOpacities: array<vec4<f32>, 20>,  // latitude line opacities (80 floats)
  lonCount: u32,                        // active longitude lines
  latCount: u32,                        // active latitude lines
  isAnimating: u32,                     // 1 if transitioning between LoD levels
  lonSpacing: f32,                      // current LoD longitude spacing in degrees
  latSpacing: f32,                      // current LoD latitude spacing in degrees
  _pad1: f32,                           // padding
  _pad2: f32,
  _pad3: f32,
}

@group(0) @binding(21) var<uniform> gridLines: GridLines;

// Helper to unpack vec4 array to get individual float
fn getGridLonDeg(i: u32) -> f32 {
  let vec_idx = i / 4u;
  let comp_idx = i % 4u;
  let v = gridLines.lonDegrees[vec_idx];
  switch (comp_idx) {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

fn getGridLonOpacity(i: u32) -> f32 {
  let vec_idx = i / 4u;
  let comp_idx = i % 4u;
  let v = gridLines.lonOpacities[vec_idx];
  switch (comp_idx) {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

fn getGridLatDeg(i: u32) -> f32 {
  let vec_idx = i / 4u;
  let comp_idx = i % 4u;
  let v = gridLines.latDegrees[vec_idx];
  switch (comp_idx) {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

fn getGridLatOpacity(i: u32) -> f32 {
  let vec_idx = i / 4u;
  let comp_idx = i % 4u;
  let v = gridLines.latOpacities[vec_idx];
  switch (comp_idx) {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

// Fast O(1) grid when not animating - uses modulo math
fn blendGridFast(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f) -> vec4f {
  let latDeg = degrees(lat);
  var lonDeg = degrees(lon);
  if (lonDeg < 0.0) { lonDeg += 360.0; }

  let dist = length(hitPoint - u.eyePosition);
  let worldUnitsPerPixel = (2.0 * u.tanFov * dist) / u.resolution.y;
  let degreesPerPixel = worldUnitsPerPixel * (180.0 / COMMON_PI);

  let halfWidth = u.gridLineWidth * 0.5 * degreesPerPixel;
  let aaZone = degreesPerPixel;
  let lonHalfWidth = min(halfWidth / max(cos(lat), 0.01), 15.0);
  let lonAaZone = min(aaZone / max(cos(lat), 0.01), 15.0);

  // Find nearest longitude line using modulo
  let nearestLon = round(lonDeg / gridLines.lonSpacing) * gridLines.lonSpacing;
  var lonDiff = abs(lonDeg - nearestLon);
  if (lonDiff > 180.0) { lonDiff = 360.0 - lonDiff; }
  let lonFactor = 1.0 - smoothstep(lonHalfWidth, lonHalfWidth + lonAaZone, lonDiff);

  // Find nearest latitude line using modulo
  let nearestLat = round(latDeg / gridLines.latSpacing) * gridLines.latSpacing;
  let latDiff = abs(latDeg - nearestLat);
  let latFactor = 1.0 - smoothstep(halfWidth, halfWidth + aaZone, latDiff);

  let gridFactor = max(lonFactor, latFactor);

  if (gridFactor > 0.001) {
    let gridColor = vec3f(1.0, 1.0, 1.0);
    return vec4f(mix(color.rgb, gridColor, gridFactor * u.gridOpacity * 0.5), color.a);
  }
  return color;
}

// Animated grid with line loops (only used during LoD transitions)
fn blendGridAnimated(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f) -> vec4f {
  let latDeg = degrees(lat);
  var lonDeg = degrees(lon);
  if (lonDeg < 0.0) { lonDeg += 360.0; }

  let dist = length(hitPoint - u.eyePosition);
  let worldUnitsPerPixel = (2.0 * u.tanFov * dist) / u.resolution.y;
  let degreesPerPixel = worldUnitsPerPixel * (180.0 / COMMON_PI);

  let halfWidth = u.gridLineWidth * 0.5 * degreesPerPixel;
  let aaZone = degreesPerPixel;
  let lonHalfWidth = min(halfWidth / max(cos(lat), 0.01), 15.0);
  let lonAaZone = min(aaZone / max(cos(lat), 0.01), 15.0);

  var gridFactor = 0.0;

  // Check longitude lines (early exit when max opacity reached)
  for (var i = 0u; i < min(gridLines.lonCount, GRID_MAX_LINES); i++) {
    let lineDeg = getGridLonDeg(i);
    let lineOpacity = getGridLonOpacity(i);
    if (lineOpacity < 0.01) { continue; }

    var diff = abs(lonDeg - lineDeg);
    if (diff > 180.0) { diff = 360.0 - diff; }
    if (diff > lonHalfWidth + lonAaZone) { continue; }

    let factor = (1.0 - smoothstep(lonHalfWidth, lonHalfWidth + lonAaZone, diff)) * lineOpacity;
    gridFactor = max(gridFactor, factor);
    if (gridFactor > 0.99) { break; }
  }

  // Check latitude lines (early exit when max opacity reached)
  for (var i = 0u; i < min(gridLines.latCount, GRID_MAX_LINES); i++) {
    var lineDeg = getGridLatDeg(i);
    let lineOpacity = getGridLatOpacity(i);
    if (lineOpacity < 0.01) { continue; }

    lineDeg = clamp(lineDeg, -90.0, 90.0);
    let diff = abs(latDeg - lineDeg);
    if (diff > halfWidth + aaZone) { continue; }

    let factor = (1.0 - smoothstep(halfWidth, halfWidth + aaZone, diff)) * lineOpacity;
    gridFactor = max(gridFactor, factor);
    if (gridFactor > 0.99) { break; }
  }

  if (gridFactor > 0.001) {
    let gridColor = vec3f(1.0, 1.0, 1.0);
    return vec4f(mix(color.rgb, gridColor, gridFactor * u.gridOpacity * 0.5), color.a);
  }
  return color;
}

// Main entry: dispatch to fast or animated path
fn blendGrid(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f) -> vec4f {
  if (u.gridOpacity < 0.01) { return color; }

  if (gridLines.isAnimating == 0u) {
    return blendGridFast(color, lat, lon, hitPoint);
  } else {
    return blendGridAnimated(color, lat, lon, hitPoint);
  }
}
