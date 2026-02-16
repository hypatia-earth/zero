// Temperature layer - weather data visualization
// Uses dynamic param bindings via sampleParam_temperature_2m()

// Texture-based colormap using shared palette array
fn colormapTemp(tempC: f32) -> vec4f {
  // Normalize data value using palette range
  let t = clamp(
    (tempC - u.tempPaletteRange.x) / (u.tempPaletteRange.y - u.tempPaletteRange.x),
    0.0, 1.0
  );
  if (u.tempPaletteStepped == 1u) {
    // Discrete bands: integer texel fetch, no filtering
    let tx = u32(clamp(t * 256.0, 0.0, 255.0));
    return textureLoad(paletteArray, vec2u(tx, u.tempPaletteIndex), 0);
  }
  // Smooth gradient: linear-filtered sample
  let v = (f32(u.tempPaletteIndex) + 0.5) / f32(u.paletteCount);
  return textureSampleLevel(paletteArray, paletteSampler, vec2f(t, v), 0.0);
}

fn blendTemp(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getLayerOpacity(LAYER_TEMP);
  if (opacity <= 0.0) { return color; }

  let cell = o1280LatLonToCell(lat, lon);
  let tempC = sampleParam_temperature_2m(cell);

  // Skip if no data or invalid values
  if (tempC == 0.0 || tempC < -100.0 || tempC > 100.0) { return color; }

  let tempColor = colormapTemp(tempC);
  let blendAlpha = opacity * tempColor.a;
  return vec4f(mix(color.rgb, tempColor.rgb, blendAlpha), color.a);
}
