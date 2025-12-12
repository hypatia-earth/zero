// Grid text labels - MSDF text at grid line intersections
// Renders N/E/S/W labels and degree numbers on the globe surface

// Font atlas binding (added to globe bindings)
@group(0) @binding(11) var fontAtlas: texture_2d<f32>;
@group(0) @binding(12) var fontSampler: sampler;

// Atlas constants from IBMPlexMono-Regular.json
const ATLAS_WIDTH: f32 = 117.0;
const ATLAS_HEIGHT: f32 = 111.0;
const FONT_SIZE: f32 = 32.0;
const DISTANCE_RANGE: f32 = 4.0;
const GLYPH_ADVANCE: f32 = 19.0;  // Monospace: all glyphs same advance

// Glyph data: vec4(x, y, width, height) from atlas JSON
// IBM Plex Mono - all xadvance = 19
const GLYPH_N_POS: vec4f = vec4f(22.0, 84.0, 18.0, 26.0);
const GLYPH_E_POS: vec4f = vec4f(41.0, 84.0, 18.0, 26.0);
const GLYPH_S_POS: vec4f = vec4f(41.0, 56.0, 20.0, 27.0);
const GLYPH_W_POS: vec4f = vec4f(60.0, 84.0, 21.0, 26.0);

// Digit glyphs 0-9
const GLYPH_0_POS: vec4f = vec4f(18.0, 0.0, 20.0, 27.0);
const GLYPH_1_POS: vec4f = vec4f(62.0, 54.0, 20.0, 26.0);
const GLYPH_2_POS: vec4f = vec4f(0.0, 29.0, 19.0, 27.0);
const GLYPH_3_POS: vec4f = vec4f(39.0, 0.0, 19.0, 27.0);
const GLYPH_4_POS: vec4f = vec4f(0.0, 85.0, 21.0, 26.0);
const GLYPH_5_POS: vec4f = vec4f(20.0, 28.0, 19.0, 27.0);
const GLYPH_6_POS: vec4f = vec4f(0.0, 57.0, 19.0, 27.0);
const GLYPH_7_POS: vec4f = vec4f(78.0, 27.0, 19.0, 26.0);
const GLYPH_8_POS: vec4f = vec4f(20.0, 56.0, 20.0, 27.0);
const GLYPH_9_POS: vec4f = vec4f(40.0, 28.0, 19.0, 27.0);

// Degree symbol
const GLYPH_DEG_POS: vec4f = vec4f(98.0, 43.0, 15.0, 15.0);

// MSDF median function
fn msdfMedian(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

// Sample a glyph at given UV offset from glyph center
// Returns opacity (0 = outside, 1 = inside glyph)
fn sampleGlyph(glyphPos: vec4f, localUV: vec2f, screenPxRange: f32) -> f32 {
  // glyphPos: x, y, width, height in atlas pixels
  // localUV: -0.5 to 0.5 relative to glyph center

  // Check if within glyph bounds
  if (abs(localUV.x) > 0.5 || abs(localUV.y) > 0.5) {
    return 0.0;
  }

  // Map localUV to atlas UV
  let atlasUV = vec2f(
    (glyphPos.x + (localUV.x + 0.5) * glyphPos.z) / ATLAS_WIDTH,
    (glyphPos.y + (localUV.y + 0.5) * glyphPos.w) / ATLAS_HEIGHT
  );

  // Sample MSDF
  let msdf = textureSampleLevel(fontAtlas, fontSampler, atlasUV, 0.0);
  let sd = msdfMedian(msdf.r, msdf.g, msdf.b);

  // Convert to opacity with anti-aliasing
  let screenPxDistance = screenPxRange * (sd - 0.5);
  return clamp(screenPxDistance + 0.5, 0.0, 1.0);
}

// Get glyph position for a digit 0-9
fn getDigitGlyph(digit: i32) -> vec4f {
  switch (digit) {
    case 0: { return GLYPH_0_POS; }
    case 1: { return GLYPH_1_POS; }
    case 2: { return GLYPH_2_POS; }
    case 3: { return GLYPH_3_POS; }
    case 4: { return GLYPH_4_POS; }
    case 5: { return GLYPH_5_POS; }
    case 6: { return GLYPH_6_POS; }
    case 7: { return GLYPH_7_POS; }
    case 8: { return GLYPH_8_POS; }
    case 9: { return GLYPH_9_POS; }
    default: { return GLYPH_0_POS; }
  }
}

// Blend grid text labels onto surface
fn blendGridText(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f) -> vec4f {
  if (u.gridEnabled == 0u) { return color; }

  let latDeg = degrees(lat);
  let lonDeg = degrees(lon);
  let spacing = 15.0;

  // Calculate screen-space metrics
  let dist = length(hitPoint - u.eyePosition);
  let worldUnitsPerPixel = (2.0 * u.tanFov * dist) / u.resolution.y;

  // Font size in screen pixels, converted to world units
  let fontSizePx = 14.0;
  let fontSizeWorld = fontSizePx * worldUnitsPerPixel * 3.0;

  // MSDF screen pixel range for anti-aliasing
  let screenPxRange = fontSizePx / DISTANCE_RANGE;

  // Find nearest grid intersection
  let nearestLat = round(latDeg / spacing) * spacing;
  let nearestLon = round(lonDeg / spacing) * spacing;

  // Distance to intersection in degrees
  let dLat = latDeg - nearestLat;
  let dLon = lonDeg - nearestLon;

  // Longitude compression at this latitude
  let lonScale = max(cos(lat), 0.01);

  // Convert degree offset to world units (on unit sphere: 1 radian = 1 unit)
  let degToRad = COMMON_PI / 180.0;
  let offsetX = dLon * degToRad * lonScale;  // East-west (compressed at poles)
  let offsetY = dLat * degToRad;              // North-south

  // Convert to glyph-relative UV (-0.5 to 0.5)
  // Glyph is fontSizeWorld units wide/tall
  let glyphUV = vec2f(
    offsetX / fontSizeWorld,
    -offsetY / fontSizeWorld  // Flip Y (north = up, but UV y increases down)
  );

  // Glyph spacing in UV units (monospace: uniform advance + 50%)
  let glyphWidth = 0.85;
  let lineHeight = 1.3;

  // Get lat/lon values
  let absLat = i32(abs(nearestLat));
  let absLon = i32(abs(nearestLon));
  let latTens = absLat / 10;
  let latOnes = absLat % 10;
  let lonHundreds = absLon / 100;
  let lonTens = (absLon / 10) % 10;
  let lonOnes = absLon % 10;
  let isNorth = nearestLat >= 0.0;
  let isEast = nearestLon >= 0.0;

  // Quadrant-based positioning:
  // N -> above line, S -> below line
  // E -> right of line, W -> left of line (right-aligned)
  let marginX = 0.4;
  let marginY = 0.5;

  // Base offset from intersection based on hemisphere
  var baseOffsetX: f32;
  var baseOffsetY: f32;

  if (isEast) {
    baseOffsetX = marginX;  // Right of vertical line
  } else {
    baseOffsetX = -marginX; // Left of vertical line
  }

  if (isNorth) {
    baseOffsetY = -marginY; // Above horizontal line
  } else {
    baseOffsetY = marginY + lineHeight; // Below horizontal line
  }

  // For W (left side), we need to right-align text
  // Calculate max width based on character count
  let latChars = select(2.0, 3.0, latTens > 0);  // "5N" or "15N"
  let lonChars = select(2.0, select(3.0, 4.0, lonHundreds > 0), lonTens > 0 || lonHundreds > 0);
  let maxChars = max(latChars, lonChars) + 0.2; // +0.2 for letter spacing

  var labelUV: vec2f;
  if (isEast) {
    // Left-aligned: start from margin
    labelUV = vec2f(glyphUV.x - baseOffsetX, glyphUV.y - baseOffsetY);
  } else {
    // Right-aligned: offset by text width so it ends at margin
    let textWidth = maxChars * glyphWidth;
    labelUV = vec2f(glyphUV.x - baseOffsetX + textWidth, glyphUV.y - baseOffsetY);
  }

  var opacity = 0.0;

  // Row 1: Latitude (e.g., "15N") - upper row
  let latY = labelUV.y;
  var latX = labelUV.x;

  // Lat tens digit (skip if 0)
  if (latTens > 0) {
    opacity = max(opacity, sampleGlyph(getDigitGlyph(latTens), vec2f(latX, latY), screenPxRange));
    latX -= glyphWidth;
  }
  // Lat ones digit
  opacity = max(opacity, sampleGlyph(getDigitGlyph(latOnes), vec2f(latX, latY), screenPxRange));
  latX -= glyphWidth * 1.2;
  // N or S
  if (isNorth) {
    opacity = max(opacity, sampleGlyph(GLYPH_N_POS, vec2f(latX, latY), screenPxRange));
  } else {
    opacity = max(opacity, sampleGlyph(GLYPH_S_POS, vec2f(latX, latY), screenPxRange));
  }

  // Row 2: Longitude (e.g., "90W") - lower row
  let lonY = labelUV.y + lineHeight;
  var lonX = labelUV.x;

  // Lon hundreds digit (skip if 0)
  if (lonHundreds > 0) {
    opacity = max(opacity, sampleGlyph(getDigitGlyph(lonHundreds), vec2f(lonX, lonY), screenPxRange));
    lonX -= glyphWidth;
  }
  // Lon tens digit (skip if both hundreds and tens are 0)
  if (lonHundreds > 0 || lonTens > 0) {
    opacity = max(opacity, sampleGlyph(getDigitGlyph(lonTens), vec2f(lonX, lonY), screenPxRange));
    lonX -= glyphWidth;
  }
  // Lon ones digit
  opacity = max(opacity, sampleGlyph(getDigitGlyph(lonOnes), vec2f(lonX, lonY), screenPxRange));
  lonX -= glyphWidth * 1.2;
  // E or W
  if (isEast) {
    opacity = max(opacity, sampleGlyph(GLYPH_E_POS, vec2f(lonX, lonY), screenPxRange));
  } else {
    opacity = max(opacity, sampleGlyph(GLYPH_W_POS, vec2f(lonX, lonY), screenPxRange));
  }

  if (opacity < 0.01) {
    return color;
  }

  // Blend white text
  let textColor = vec3f(1.0, 1.0, 1.0);
  let alpha = opacity * 0.9;

  return vec4f(mix(color.rgb, textColor, alpha), color.a);
}
