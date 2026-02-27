// Graticule layer - animated lat/lon graticule overlay
// Lines are passed as uniforms for LoD animation

const GRATICULE_MAX_LINES: u32 = 80u;

// Graticule line data from GraticuleAnimator
// Uses vec4 packing for 16-byte uniform alignment: 20 vec4s = 80 floats
struct GraticuleLines {
  lonDegrees: array<vec4<f32>, 20>,    // longitude line positions (80 floats)
  lonOpacities: array<vec4<f32>, 20>,  // longitude line opacities (80 floats)
  latDegrees: array<vec4<f32>, 20>,    // latitude line positions (80 floats)
  latOpacities: array<vec4<f32>, 20>,  // latitude line opacities (80 floats)
  lonCount: u32,                        // active longitude lines
  latCount: u32,                        // active latitude lines
  isAnimating: u32,                     // 1 if transitioning between LoD levels
  spacing: f32,                         // current LoD spacing in degrees (same for lon/lat)
  _pad0: f32,                           // padding (was latSpacing, now unused)
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
}

@group(0) @binding(21) var<uniform> graticuleLines: GraticuleLines;

// Helper to unpack vec4 array to get individual float
fn getGraticuleLonDeg(i: u32) -> f32 {
  let vec_idx = i / 4u;
  let comp_idx = i % 4u;
  let v = graticuleLines.lonDegrees[vec_idx];
  switch (comp_idx) {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

fn getGraticuleLonOpacity(i: u32) -> f32 {
  let vec_idx = i / 4u;
  let comp_idx = i % 4u;
  let v = graticuleLines.lonOpacities[vec_idx];
  switch (comp_idx) {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

fn getGraticuleLatDeg(i: u32) -> f32 {
  let vec_idx = i / 4u;
  let comp_idx = i % 4u;
  let v = graticuleLines.latDegrees[vec_idx];
  switch (comp_idx) {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

fn getGraticuleLatOpacity(i: u32) -> f32 {
  let vec_idx = i / 4u;
  let comp_idx = i % 4u;
  let v = graticuleLines.latOpacities[vec_idx];
  switch (comp_idx) {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

// Fast O(1) graticule when not animating - uses modulo math
fn blendGraticuleFast(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f, graticuleOpacity: f32) -> vec4f {
  let latDeg = degrees(lat);
  var lonDeg = degrees(lon);
  if (lonDeg < 0.0) { lonDeg += 360.0; }

  let dist = length(hitPoint - u.eyePosition);
  let worldUnitsPerPixel = (2.0 * u.tanFov * dist) / u.resolution.y;
  let degreesPerPixel = worldUnitsPerPixel * (180.0 / COMMON_PI);

  let halfWidth = u.graticuleLineWidth * 0.5 * degreesPerPixel;
  let aaZone = degreesPerPixel;
  let lonHalfWidth = min(halfWidth / max(cos(lat), 0.01), 15.0);
  let lonAaZone = min(aaZone / max(cos(lat), 0.01), 15.0);

  // Find nearest longitude line using modulo
  let nearestLon = round(lonDeg / graticuleLines.spacing) * graticuleLines.spacing;
  var lonDiff = abs(lonDeg - nearestLon);
  if (lonDiff > 180.0) { lonDiff = 360.0 - lonDiff; }
  let lonFactor = 1.0 - smoothstep(lonHalfWidth, lonHalfWidth + lonAaZone, lonDiff);

  // Find nearest latitude line using modulo
  let nearestLat = round(latDeg / graticuleLines.spacing) * graticuleLines.spacing;
  let latDiff = abs(latDeg - nearestLat);
  let latFactor = 1.0 - smoothstep(halfWidth, halfWidth + aaZone, latDiff);

  let graticuleFactor = max(lonFactor, latFactor);

  if (graticuleFactor > 0.001) {
    let graticuleColor = vec3f(1.0, 1.0, 1.0);
    return vec4f(mix(color.rgb, graticuleColor, graticuleFactor * graticuleOpacity * 0.5), color.a);
  }
  return color;
}

// Animated graticule with line loops (only used during LoD transitions)
fn blendGraticuleAnimated(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f, graticuleOpacity: f32) -> vec4f {
  let latDeg = degrees(lat);
  var lonDeg = degrees(lon);
  if (lonDeg < 0.0) { lonDeg += 360.0; }

  let dist = length(hitPoint - u.eyePosition);
  let worldUnitsPerPixel = (2.0 * u.tanFov * dist) / u.resolution.y;
  let degreesPerPixel = worldUnitsPerPixel * (180.0 / COMMON_PI);

  let halfWidth = u.graticuleLineWidth * 0.5 * degreesPerPixel;
  let aaZone = degreesPerPixel;
  let lonHalfWidth = min(halfWidth / max(cos(lat), 0.01), 15.0);
  let lonAaZone = min(aaZone / max(cos(lat), 0.01), 15.0);

  var graticuleFactor = 0.0;

  // Check longitude lines (early exit when max opacity reached)
  for (var i = 0u; i < min(graticuleLines.lonCount, GRATICULE_MAX_LINES); i++) {
    let lineDeg = getGraticuleLonDeg(i);
    let lineOpacity = getGraticuleLonOpacity(i);
    if (lineOpacity < 0.01) { continue; }

    var diff = abs(lonDeg - lineDeg);
    if (diff > 180.0) { diff = 360.0 - diff; }
    if (diff > lonHalfWidth + lonAaZone) { continue; }

    let factor = (1.0 - smoothstep(lonHalfWidth, lonHalfWidth + lonAaZone, diff)) * lineOpacity;
    graticuleFactor = max(graticuleFactor, factor);
    if (graticuleFactor > 0.99) { break; }
  }

  // Check latitude lines (early exit when max opacity reached)
  for (var i = 0u; i < min(graticuleLines.latCount, GRATICULE_MAX_LINES); i++) {
    var lineDeg = getGraticuleLatDeg(i);
    let lineOpacity = getGraticuleLatOpacity(i);
    if (lineOpacity < 0.01) { continue; }

    lineDeg = clamp(lineDeg, -90.0, 90.0);
    let diff = abs(latDeg - lineDeg);
    if (diff > halfWidth + aaZone) { continue; }

    let factor = (1.0 - smoothstep(halfWidth, halfWidth + aaZone, diff)) * lineOpacity;
    graticuleFactor = max(graticuleFactor, factor);
    if (graticuleFactor > 0.99) { break; }
  }

  if (graticuleFactor > 0.001) {
    let graticuleColor = vec3f(1.0, 1.0, 1.0);
    return vec4f(mix(color.rgb, graticuleColor, graticuleFactor * graticuleOpacity * 0.5), color.a);
  }
  return color;
}

// Main entry: dispatch to fast or animated path
fn blendGraticule(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f) -> vec4f {
  let graticuleOpacity = getLayerOpacity(LAYER_GRATICULE);
  if (graticuleOpacity < 0.01) { return color; }

  if (graticuleLines.isAnimating == 0u) {
    return blendGraticuleFast(color, lat, lon, hitPoint, graticuleOpacity);
  } else {
    return blendGraticuleAnimated(color, lat, lon, hitPoint, graticuleOpacity);
  }
}
