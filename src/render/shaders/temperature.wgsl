// Temperature layer - weather data visualization

const TEMP_POINTS_PER_SLOT: u32 = 6599680u;  // Points per timestep slot

// Binary search for Gaussian latitude ring
fn tempFindRing(lat: f32) -> u32 {
  var lo: u32 = 0u;
  var hi: u32 = 2559u;
  while (lo < hi) {
    let mid = (lo + hi) / 2u;
    if (gaussianLats[mid] > lat) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  return lo;
}

fn tempLatLonToCell(lat: f32, lon: f32) -> u32 {
  let ring = tempFindRing(lat);
  let ringFromPole = select(ring + 1u, 2560u - ring, ring >= 1280u);
  let nPoints = 4u * ringFromPole + 16u;
  var lonNorm = lon;
  if (lonNorm < 0.0) { lonNorm += COMMON_TAU; }
  let lonIdx = u32(floor(lonNorm / COMMON_TAU * f32(nPoints))) % nPoints;
  return ringOffsets[ring] + lonIdx;
}

fn colormapTemp(tempC: f32) -> vec3f {
  let t = clamp((tempC + 40.0) / 90.0, 0.0, 1.0);
  // Blue -> Cyan -> Green -> Yellow -> Red
  if (t < 0.25) {
    return mix(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 1.0), t * 4.0);
  } else if (t < 0.5) {
    return mix(vec3f(0.0, 1.0, 1.0), vec3f(0.0, 1.0, 0.0), (t - 0.25) * 4.0);
  } else if (t < 0.75) {
    return mix(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 1.0, 0.0), (t - 0.5) * 4.0);
  } else {
    return mix(vec3f(1.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), (t - 0.75) * 4.0);
  }
}

// ESRI "Meaningful Temperature Palette" - designed for intuitive weather mapping
// Source: https://www.esri.com/arcgis-blog/products/arcgis-pro/mapping/a-meaningful-temperature-palette
// Key: discrete 5°F bands, dark navy at freezing, yellows comfortable, reds danger
// NO gradient mixing - each band is a solid color for clear visual distinction
fn colormapTempESRI(tempC: f32) -> vec3f {
  // Convert Celsius to Fahrenheit for palette lookup (5°F bands)
  let tempF = tempC * 1.8 + 32.0;

  // Extreme cold (< -60°F)
  if (tempF < -60.0) { return vec3f(0.82, 0.86, 0.88); }
  if (tempF < -55.0) { return vec3f(0.80, 0.84, 0.86); }
  if (tempF < -50.0) { return vec3f(0.78, 0.82, 0.85); }
  if (tempF < -45.0) { return vec3f(0.75, 0.80, 0.83); }
  if (tempF < -40.0) { return vec3f(0.72, 0.78, 0.82); }
  // Very cold gray-blues
  if (tempF < -35.0) { return vec3f(0.68, 0.75, 0.80); }
  if (tempF < -30.0) { return vec3f(0.64, 0.72, 0.78); }
  if (tempF < -25.0) { return vec3f(0.60, 0.69, 0.75); }
  if (tempF < -20.0) { return vec3f(0.56, 0.66, 0.72); }
  if (tempF < -15.0) { return vec3f(0.52, 0.63, 0.70); }
  if (tempF < -10.0) { return vec3f(0.48, 0.60, 0.68); }
  if (tempF <  -5.0) { return vec3f(0.44, 0.56, 0.65); }
  if (tempF <   0.0) { return vec3f(0.40, 0.52, 0.62); }
  // Cold blues
  if (tempF <   5.0) { return vec3f(0.36, 0.48, 0.60); }
  if (tempF <  10.0) { return vec3f(0.32, 0.44, 0.58); }
  if (tempF <  15.0) { return vec3f(0.28, 0.40, 0.55); }
  if (tempF <  20.0) { return vec3f(0.24, 0.36, 0.52); }
  if (tempF <  25.0) { return vec3f(0.20, 0.32, 0.48); }
  if (tempF <  30.0) { return vec3f(0.16, 0.26, 0.42); }
  // FREEZING WALL - dark navy (30-35°F / ~0°C)
  if (tempF <  35.0) { return vec3f(0.125, 0.19, 0.34); }
  // Cool navy to teal
  if (tempF <  40.0) { return vec3f(0.16, 0.30, 0.45); }
  if (tempF <  45.0) { return vec3f(0.20, 0.38, 0.52); }
  if (tempF <  50.0) { return vec3f(0.24, 0.46, 0.58); }
  // TURQUOISE BRIDGE (50-55°F)
  if (tempF <  55.0) { return vec3f(0.30, 0.52, 0.58); }
  if (tempF <  60.0) { return vec3f(0.38, 0.55, 0.52); }
  // Transitional teal-green (MINIMAL GREEN)
  if (tempF <  65.0) { return vec3f(0.45, 0.58, 0.48); }
  if (tempF <  70.0) { return vec3f(0.52, 0.60, 0.42); }
  // Comfortable yellows (70-85°F)
  if (tempF <  75.0) { return vec3f(0.62, 0.62, 0.36); }
  if (tempF <  80.0) { return vec3f(0.72, 0.60, 0.32); }
  if (tempF <  85.0) { return vec3f(0.78, 0.55, 0.28); }
  // Warming orange-golds (85-100°F)
  if (tempF <  90.0) { return vec3f(0.82, 0.48, 0.24); }
  if (tempF <  95.0) { return vec3f(0.84, 0.40, 0.22); }
  if (tempF < 100.0) { return vec3f(0.85, 0.33, 0.22); }
  // DANGER ZONE - pinks/reds (100°F+)
  if (tempF < 105.0) { return vec3f(0.85, 0.28, 0.35); }
  if (tempF < 110.0) { return vec3f(0.78, 0.22, 0.32); }
  if (tempF < 115.0) { return vec3f(0.68, 0.16, 0.28); }
  if (tempF < 120.0) { return vec3f(0.58, 0.13, 0.24); }
  // Extreme heat - dark maroon
  return vec3f(0.42, 0.11, 0.17);
}

// Read temperature value from slot-based buffer
fn getTempFromSlot(cell: u32, slot: u32) -> f32 {
  let index = slot * TEMP_POINTS_PER_SLOT + cell;
  return tempData[index];
}

fn blendTemp(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.tempDataReady == 0u || u.tempOpacity <= 0.0) { return color; }
  let cell = tempLatLonToCell(lat, lon);

  // Progressive loading: skip cells not yet loaded
  if (cell >= u.tempLoadedPoints) { return color; }

  // Read from slots and interpolate (lerp < -1.5 means single slot mode)
  let temp0 = getTempFromSlot(cell, u.tempSlot0);
  var tempC: f32;
  if (u.tempLerp < -1.5) {
    tempC = temp0;  // Single slot mode: no interpolation
  } else {
    let temp1 = getTempFromSlot(cell, u.tempSlot1);
    tempC = mix(temp0, temp1, u.tempLerp);  // Data is already in Celsius
  }

  // Skip invalid data
  if (tempC < -100.0 || tempC > 100.0) { return color; }

  let tempColor = colormapTempESRI(tempC);
  return vec4f(mix(color.rgb, tempColor, u.tempOpacity), color.a);
}
