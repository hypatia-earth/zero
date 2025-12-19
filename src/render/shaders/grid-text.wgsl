// Grid text labels - MSDF text at grid line intersections
// Renders coordinate labels (e.g., "15N", "45W") on the globe surface

// Font atlas binding
@group(0) @binding(11) var fontAtlas: texture_2d<f32>;
@group(0) @binding(12) var fontSampler: sampler;

// Atlas constants from IBMPlexMono-Regular.json
const ATLAS_WIDTH: f32 = 117.0;
const ATLAS_HEIGHT: f32 = 111.0;
const DISTANCE_RANGE: f32 = 4.0;

// Layout constants
const GLYPH_WIDTH: f32 = 0.85;        // Horizontal spacing between glyphs
const GLYPH_WIDTH_LETTER: f32 = 1.02; // Extra spacing before direction letter (GLYPH_WIDTH * 1.2)
const LINE_HEIGHT: f32 = 1.3;         // Vertical spacing between rows
const MARGIN_X: f32 = 0.4;            // Horizontal margin from grid line
const MARGIN_Y: f32 = 0.5;            // Vertical margin from grid line
const OFFSET_X: f32 = 0.5;            // X shift for alignment
const OFFSET_Y_NORTH: f32 = 0.5;      // Y shift for N hemisphere
const OFFSET_Y_SOUTH: f32 = -1.0;     // Y shift for S hemisphere
const CHAR_COUNT_OFFSET: f32 = 0.2;   // Extra offset for character count calc
const TEXT_OPACITY: f32 = 0.9;        // Label opacity
const GRID_SPACING: f32 = 15.0;       // Grid line spacing in degrees
const WORLD_SCALE: f32 = 3.0;         // Font size world scale multiplier

// Glyph atlas positions: vec4(x, y, width, height)
const GLYPH_N_POS: vec4f = vec4f(22.0, 84.0, 18.0, 26.0);
const GLYPH_E_POS: vec4f = vec4f(41.0, 84.0, 18.0, 26.0);
const GLYPH_S_POS: vec4f = vec4f(41.0, 56.0, 20.0, 27.0);
const GLYPH_W_POS: vec4f = vec4f(60.0, 84.0, 21.0, 26.0);

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

// MSDF median function
fn msdfMedian(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

// Sample a glyph at given UV offset from glyph center
fn sampleGlyph(glyphPos: vec4f, localUV: vec2f, screenPxRange: f32) -> f32 {
  if (abs(localUV.x) > 0.5 || abs(localUV.y) > 0.5) {
    return 0.0;
  }

  let atlasUV = vec2f(
    (glyphPos.x + (localUV.x + 0.5) * glyphPos.z) / ATLAS_WIDTH,
    (glyphPos.y + (localUV.y + 0.5) * glyphPos.w) / ATLAS_HEIGHT
  );

  let msdf = textureSampleLevel(fontAtlas, fontSampler, atlasUV, 0.0);
  let sd = msdfMedian(msdf.r, msdf.g, msdf.b);
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

// Render latitude row (e.g., "15N" or "0S")
fn renderLatRow(
  latTens: i32, latOnes: i32, isNorth: bool,
  startX: f32, y: f32, screenPxRange: f32
) -> f32 {
  var opacity = 0.0;
  var x = startX;

  if (latTens > 0) {
    opacity = max(opacity, sampleGlyph(getDigitGlyph(latTens), vec2f(x, y), screenPxRange));
    x -= GLYPH_WIDTH;
  }
  opacity = max(opacity, sampleGlyph(getDigitGlyph(latOnes), vec2f(x, y), screenPxRange));
  x -= GLYPH_WIDTH_LETTER;

  let dirGlyph = select(GLYPH_S_POS, GLYPH_N_POS, isNorth);
  opacity = max(opacity, sampleGlyph(dirGlyph, vec2f(x, y), screenPxRange));

  return opacity;
}

// Render longitude row (e.g., "45E", "120W", or "0E")
fn renderLonRow(
  lonHundreds: i32, lonTens: i32, lonOnes: i32, isEast: bool,
  startX: f32, y: f32, screenPxRange: f32
) -> f32 {
  var opacity = 0.0;
  var x = startX;

  if (lonHundreds > 0) {
    opacity = max(opacity, sampleGlyph(getDigitGlyph(lonHundreds), vec2f(x, y), screenPxRange));
    x -= GLYPH_WIDTH;
  }
  if (lonHundreds > 0 || lonTens > 0) {
    opacity = max(opacity, sampleGlyph(getDigitGlyph(lonTens), vec2f(x, y), screenPxRange));
    x -= GLYPH_WIDTH;
  }
  opacity = max(opacity, sampleGlyph(getDigitGlyph(lonOnes), vec2f(x, y), screenPxRange));
  x -= GLYPH_WIDTH_LETTER;

  let dirGlyph = select(GLYPH_W_POS, GLYPH_E_POS, isEast);
  opacity = max(opacity, sampleGlyph(dirGlyph, vec2f(x, y), screenPxRange));

  return opacity;
}

// Blend grid text labels onto surface
fn blendGridText(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f) -> vec4f {
  if (u.gridOpacity < 0.01) { return color; }

  let latDeg = degrees(lat);
  let lonDeg = degrees(lon);

  // Globe-space metrics (font size fixed on globe surface)
  let fontSizeWorld = u.gridFontSize * 0.002;  // gridFontSize in globe units
  let dist = length(hitPoint - u.eyePosition);
  let worldUnitsPerPixel = (2.0 * u.tanFov * dist) / u.resolution.y;
  let screenPxRange = (fontSizeWorld / worldUnitsPerPixel) / DISTANCE_RANGE;

  // Find nearest grid intersection
  let nearestLat = round(latDeg / GRID_SPACING) * GRID_SPACING;
  let nearestLon = round(lonDeg / GRID_SPACING) * GRID_SPACING;

  // Convert offset to glyph UV space
  let dLat = latDeg - nearestLat;
  let dLon = lonDeg - nearestLon;
  let lonScale = max(cos(lat), 0.01);
  let degToRad = COMMON_PI / 180.0;
  let glyphUV = vec2f(
    (dLon * degToRad * lonScale) / fontSizeWorld,
    -(dLat * degToRad) / fontSizeWorld
  );

  // Extract coordinate digits
  let absLat = i32(abs(nearestLat));
  let absLon = i32(abs(nearestLon));
  let latTens = absLat / 10;
  let latOnes = absLat % 10;
  let lonHundreds = absLon / 100;
  let lonTens = (absLon / 10) % 10;
  let lonOnes = absLon % 10;
  let isNorth = nearestLat >= 0.0;
  let isEast = nearestLon >= 0.0;

  // Character counts for alignment
  let latCharCount = select(2.0, 3.0, latTens > 0);
  let lonCharCount = select(2.0, select(3.0, 4.0, lonHundreds > 0), lonTens > 0 || lonHundreds > 0);

  // Y offset based on hemisphere (computed once)
  let yOffset = select(OFFSET_Y_SOUTH, OFFSET_Y_NORTH, isNorth);
  let baseY = glyphUV.y - select(MARGIN_Y + LINE_HEIGHT, -MARGIN_Y, isNorth) + yOffset;

  var opacity = 0.0;

  if (isEast) {
    // East: left-aligned
    let startX = glyphUV.x - MARGIN_X - OFFSET_X;
    opacity = max(opacity, renderLatRow(latTens, latOnes, isNorth, startX, baseY, screenPxRange));
    opacity = max(opacity, renderLonRow(lonHundreds, lonTens, lonOnes, isEast, startX, baseY + LINE_HEIGHT, screenPxRange));
  } else {
    // West: right-aligned (each row positioned by its char count)
    let endX = glyphUV.x + MARGIN_X;
    let latStartX = endX + (latCharCount + CHAR_COUNT_OFFSET) * GLYPH_WIDTH;
    let lonStartX = endX + (lonCharCount + CHAR_COUNT_OFFSET) * GLYPH_WIDTH;
    opacity = max(opacity, renderLatRow(latTens, latOnes, isNorth, latStartX, baseY, screenPxRange));
    opacity = max(opacity, renderLonRow(lonHundreds, lonTens, lonOnes, isEast, lonStartX, baseY + LINE_HEIGHT, screenPxRange));
  }

  if (opacity < 0.01) {
    return color;
  }

  return vec4f(mix(color.rgb, vec3f(1.0), opacity * TEXT_OPACITY * u.gridOpacity), color.a);
}
