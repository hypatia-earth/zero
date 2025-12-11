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

  // Read from slots and interpolate
  let temp0 = getTempFromSlot(cell, u.tempSlot0);
  let temp1 = getTempFromSlot(cell, u.tempSlot1);
  let tempC = mix(temp0, temp1, u.tempLerp);  // Data is already in Celsius

  // Skip invalid data
  if (tempC < -100.0 || tempC > 100.0) { return color; }

  let tempColor = colormapTemp(tempC);
  return vec4f(mix(color.rgb, tempColor, u.tempOpacity), color.a);
}
