// Temperature layer - weather data visualization
// Uses dynamic param bindings via sampleParam_temperature_2m()

// Texture-based colormap using 1D palette
fn colormapTemp(tempC: f32) -> vec3f {
  let t = clamp(
    (tempC - u.tempPaletteRange.x) / (u.tempPaletteRange.y - u.tempPaletteRange.x),
    0.0, 1.0
  );
  return textureSampleLevel(tempPalette, tempPaletteSampler, vec2f(t, 0.5), 0.0).rgb;
}

fn blendTemp(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getLayerOpacity(LAYER_TEMP);
  if (opacity <= 0.0) { return color; }

  let cell = o1280LatLonToCell(lat, lon);
  let tempC = sampleParam_temperature_2m(cell);

  // Skip if no data or invalid values
  if (tempC == 0.0 || tempC < -100.0 || tempC > 100.0) { return color; }

  let tempColor = colormapTemp(tempC);
  return vec4f(mix(color.rgb, tempColor, opacity), color.a);
}
