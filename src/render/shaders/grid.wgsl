// Grid layer - lat/lon grid overlay

fn blendGrid(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.gridEnabled == 0u) { return color; }
  let latDeg = degrees(lat);
  let lonDeg = degrees(lon);
  let spacing = 15.0;
  let width = 0.4;
  let latLine = abs(fract(latDeg / spacing + 0.5) - 0.5) * spacing;
  let lonLine = abs(fract(lonDeg / spacing + 0.5) - 0.5) * spacing;
  let onGrid = min(latLine, lonLine) < width;
  if (onGrid) {
    let gridColor = vec3f(1.0, 1.0, 1.0);
    return vec4f(mix(color.rgb, gridColor, u.gridOpacity * 0.5), color.a);
  }
  return color;
}
