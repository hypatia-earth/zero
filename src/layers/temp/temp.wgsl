// Temperature layer - weather data visualization
// Uses two separate buffers (tempData0, tempData1) for interpolation
// Buffers are rebound when active slots change (no offset math needed)
// Uses shared O1280 projection from projection-o1280.wgsl

// Texture-based colormap using 1D palette
fn colormapTemp(tempC: f32) -> vec3f {
  let t = clamp(
    (tempC - u.tempPaletteRange.x) / (u.tempPaletteRange.y - u.tempPaletteRange.x),
    0.0, 1.0
  );
  // Use textureSampleLevel to avoid non-uniform control flow issues
  return textureSampleLevel(tempPalette, tempPaletteSampler, vec2f(t, 0.5), 0.0).rgb;
}

fn blendTemp(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.tempDataReady == 0u || u.tempOpacity <= 0.0) { return color; }

  let cell = o1280LatLonToCell(lat, lon);

  // Progressive loading: skip cells not yet loaded
  if (cell >= u.tempLoadedPoints) { return color; }

  // Read directly from bound buffers (no offset math - buffers rebound on slot change)
  let temp0 = tempData0[cell];
  var tempC: f32;
  if (u.tempLerp < -1.5) {
    tempC = temp0;  // Single slot mode: no interpolation
  } else {
    let temp1 = tempData1[cell];
    tempC = mix(temp0, temp1, u.tempLerp);  // Data is already in Celsius
  }

  // Skip invalid data
  if (tempC < -100.0 || tempC > 100.0) { return color; }

  let tempColor = colormapTemp(tempC);
  return vec4f(mix(color.rgb, tempColor, u.tempOpacity), color.a);
}
