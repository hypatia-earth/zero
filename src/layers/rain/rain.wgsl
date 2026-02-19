// Rain/precipitation type layer
// Uses dynamic param bindings via sampleParam_precipitation_type()
// WMO codes: 0=none, 1=rain, 3=freezing rain, 5=snow, 6=wet snow, 7=rain+snow, 8=ice pellets, 12=freezing drizzle
// Palette: rain-type (stepped, stops at normalized WMO code positions: value/12)

fn colormapPrecipType(ptype: f32, opacity: f32) -> vec4f {
  if (ptype < 0.5) { return vec4f(0.0); }  // code 0: no precipitation
  let range = getLayerPaletteRange(LAYER_RAIN);
  let t = clamp((ptype - range.x) / (range.y - range.x), 0.0, 1.0);
  let c = samplePalette(t, getLayerPaletteIndex(LAYER_RAIN));
  return vec4f(c.rgb, c.a * opacity);
}

fn blendRain(color: vec4f, lat: f32, lon: f32) -> vec4f {
  let opacity = getLayerOpacity(LAYER_RAIN);
  let cell = o1280LatLonToCell(lat, lon);
  let ptype = sampleParam_precipitation_type(cell);
  let rainColor = colormapPrecipType(ptype, opacity);
  if (rainColor.a <= 0.0) { return color; }
  return vec4f(mix(color.rgb, rainColor.rgb, rainColor.a), color.a);
}
