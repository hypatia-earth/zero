// Temperature layer - weather data visualization
// Uses dynamic param bindings via sampleParam_temperature_2m()

// Texture-based colormap using shared palette array
fn colormapTemp(tempC: f32) -> vec4f {
  // Normalize data value using palette range
  let t = clamp(
    (tempC - u.tempPaletteRange.x) / (u.tempPaletteRange.y - u.tempPaletteRange.x),
    0.0, 1.0
  );
  return samplePalette(t, u.tempPaletteIndex);
}

fn blendTemp(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getLayerOpacity(LAYER_TEMP);
  let cell = o1280LatLonToCell(lat, lon);
  let tempC = sampleParam_temperature_2m(cell);

  // Skip if no data or invalid values
  if (tempC == 0.0 || tempC < -100.0 || tempC > 100.0) { return color; }

  let tempColor = colormapTemp(tempC);
  let blendAlpha = opacity * tempColor.a;
  return vec4f(mix(color.rgb, tempColor.rgb, blendAlpha), color.a);
}
