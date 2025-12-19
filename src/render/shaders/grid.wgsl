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
  _pad: vec2<u32>,                     // padding to 16-byte alignment
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

// Screen-space grid with animated line positions
fn blendGrid(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f) -> vec4f {
  if (u.gridOpacity < 0.01) { return color; }

  let latDeg = degrees(lat);
  // Normalize longitude to 0-360 range
  var lonDeg = degrees(lon);
  if (lonDeg < 0.0) { lonDeg += 360.0; }

  // Calculate per-pixel line width based on distance
  let dist = length(hitPoint - u.eyePosition);
  let worldUnitsPerPixel = (2.0 * u.tanFov * dist) / u.resolution.y;
  let degreesPerPixel = worldUnitsPerPixel * (180.0 / COMMON_PI);

  let pixelWidth = 3.0;  // Line width in screen pixels
  let width = pixelWidth * degreesPerPixel;

  // Longitude width compensation for latitude (clamped to avoid pole artifacts)
  let lonWidth = min(width / max(cos(lat), 0.01), 30.0);  // Max 30° width

  var gridFactor = 0.0;

  // Check longitude lines
  for (var i = 0u; i < min(gridLines.lonCount, GRID_MAX_LINES); i++) {
    var lineDeg = getGridLonDeg(i);
    let lineOpacity = getGridLonOpacity(i);
    if (lineOpacity < 0.01) { continue; }

    // Normalize line position to [0, 360) in case animation overshoots
    lineDeg = lineDeg - floor(lineDeg / 360.0) * 360.0;

    // Distance to this line (handling wraparound)
    var diff = abs(lonDeg - lineDeg);
    if (diff > 180.0) { diff = 360.0 - diff; }

    // Convert to screen distance accounting for latitude
    let screenDist = diff;
    let factor = (1.0 - smoothstep(lonWidth * 0.5, lonWidth, screenDist)) * lineOpacity;
    gridFactor = max(gridFactor, factor);
  }

  // Check latitude lines
  for (var i = 0u; i < min(gridLines.latCount, GRID_MAX_LINES); i++) {
    var lineDeg = getGridLatDeg(i);
    let lineOpacity = getGridLatOpacity(i);
    if (lineOpacity < 0.01) { continue; }

    // Clamp latitude to valid range
    lineDeg = clamp(lineDeg, -90.0, 90.0);

    let diff = abs(latDeg - lineDeg);
    let factor = (1.0 - smoothstep(width * 0.5, width, diff)) * lineOpacity;
    gridFactor = max(gridFactor, factor);
  }

  if (gridFactor > 0.001) {
    let gridColor = vec3f(1.0, 1.0, 1.0);
    return vec4f(mix(color.rgb, gridColor, gridFactor * u.gridOpacity * 0.5), color.a);
  }
  return color;
}

// Legacy fixed-spacing grid (for reference/fallback)
fn blendGridFixed(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f) -> vec4f {
  if (u.gridOpacity < 0.01) { return color; }

  let latDeg = degrees(lat);
  let lonDeg = degrees(lon);
  let spacing = 15.0;

  let dist = length(hitPoint - u.eyePosition);
  let worldUnitsPerPixel = (2.0 * u.tanFov * dist) / u.resolution.y;
  let degreesPerPixel = worldUnitsPerPixel * (180.0 / COMMON_PI);

  let pixelWidth = 3.0;
  let width = pixelWidth * degreesPerPixel;
  let lonWidth = width / max(cos(lat), 0.01);

  let latLine = abs(fract(latDeg / spacing + 0.5) - 0.5) * spacing;
  let lonLine = abs(fract(lonDeg / spacing + 0.5) - 0.5) * spacing;

  let latFactor = 1.0 - smoothstep(width * 0.5, width, latLine);
  let lonFactor = 1.0 - smoothstep(lonWidth * 0.5, lonWidth, lonLine);
  let gridFactor = max(latFactor, lonFactor);

  if (gridFactor > 0.001) {
    let gridColor = vec3f(1.0, 1.0, 1.0);
    return vec4f(mix(color.rgb, gridColor, gridFactor * u.gridOpacity * 0.5), color.a);
  }
  return color;
}
