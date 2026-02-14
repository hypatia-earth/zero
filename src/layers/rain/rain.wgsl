// Rain/precipitation type layer
// Uses dynamic param bindings via sampleParam_precipitation_type()
// Values: 0=none, 1=rain, 2=snow, 3=mix

fn colormapPrecipType(ptype: f32) -> vec4f {
  // Round to nearest integer category
  let cat = u32(ptype + 0.5);

  switch cat {
    case 1u: { return vec4f(0.3, 0.5, 1.0, u.rainOpacity); }   // rain: blue
    case 2u: { return vec4f(0.9, 0.95, 1.0, u.rainOpacity); }  // snow: white
    case 3u: { return vec4f(0.6, 0.4, 0.8, u.rainOpacity); }   // mix: purple
    default: { return vec4f(0.0); }                            // none: transparent
  }
}

fn blendRain(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.rainOpacity <= 0.0) { return color; }
  let cell = o1280LatLonToCell(lat, lon);
  let ptype = sampleParam_precipitation_type(cell);
  let rainColor = colormapPrecipType(ptype);
  if (rainColor.a <= 0.0) { return color; }
  return vec4f(mix(color.rgb, rainColor.rgb, rainColor.a), color.a);
}
