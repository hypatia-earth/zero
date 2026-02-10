// Rain/precipitation layer

fn rainLatLonToCell(lat: f32, lon: f32) -> u32 {
  // Reuse temperature's cell lookup (same Gaussian grid)
  return tempLatLonToCell(lat, lon);
}

fn colormapRain(mm: f32) -> vec4f {
  if (mm < 0.1) { return vec4f(0.0); }
  let t = clamp(log(mm + 1.0) / log(51.0), 0.0, 1.0);
  let color = mix(vec3f(0.5, 0.7, 1.0), vec3f(0.2, 0.0, 0.6), t);
  return vec4f(color, u.rainOpacity * min(t + 0.3, 1.0));
}

fn blendRain(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.rainDataReady == 0u || u.rainOpacity <= 0.0) { return color; }
  let cell = rainLatLonToCell(lat, lon);
  let mm = rainData[cell];
  let rainColor = colormapRain(mm);
  if (rainColor.a <= 0.0) { return color; }
  return vec4f(mix(color.rgb, rainColor.rgb, rainColor.a), color.a);
}
