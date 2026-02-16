// Rain/precipitation type layer
// Uses dynamic param bindings via sampleParam_precipitation_type()
// Values: 0=none, 1=rain, 2=snow, 3=mix
// Palette: rain-type (stepped, 4 categories mapped to 0.0, 0.33, 0.66, 1.0)

fn colormapPrecipType(ptype: f32, opacity: f32) -> vec4f {
  if (ptype < 0.5) { return vec4f(0.0); }  // none: transparent
  let t = clamp((ptype - 0.5) / 2.5, 0.0, 1.0);
  let c = samplePalette(t, u.rainPaletteIndex);
  return vec4f(c.rgb, c.a * opacity);
}

fn blendRain(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getLayerOpacity(LAYER_RAIN);
  if (opacity <= 0.0) { return color; }
  let cell = o1280LatLonToCell(lat, lon);
  let ptype = sampleParam_precipitation_type(cell);
  let rainColor = colormapPrecipType(ptype, opacity);
  if (rainColor.a <= 0.0) { return color; }
  return vec4f(mix(color.rgb, rainColor.rgb, rainColor.a), color.a);
}
