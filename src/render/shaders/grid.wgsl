// Grid layer - lat/lon grid overlay

// Original grid function - line width in degrees (world space)
// Lines appear thicker when zoomed in, thinner when zoomed out
// Good for: consistent geographic meaning (0.4° is always 0.4°)
fn blendGridDegrees(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.gridOpacity < 0.01) { return color; }

  let latDeg = degrees(lat);
  let lonDeg = degrees(lon);
  let spacing = 15.0;  // Grid every 15 degrees
  let width = 0.4;     // Line width in degrees (~44km at equator)

  // Distance to nearest grid line (in degrees)
  // fract() gives 0-1, shift by 0.5 to center, abs() for distance from center
  let latLine = abs(fract(latDeg / spacing + 0.5) - 0.5) * spacing;
  let lonLine = abs(fract(lonDeg / spacing + 0.5) - 0.5) * spacing;

  // On grid if within width of either lat or lon line
  let onGrid = min(latLine, lonLine) < width;
  if (onGrid) {
    let gridColor = vec3f(1.0, 1.0, 1.0);
    return vec4f(mix(color.rgb, gridColor, u.gridOpacity * 0.5), color.a);
  }
  return color;
}

// Screen-space grid - line width in pixels (constant visual thickness)
// Lines appear same thickness regardless of zoom level
// Good for: consistent visual appearance, clean UI at any zoom
fn blendGrid(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f) -> vec4f {
  if (u.gridOpacity < 0.01) { return color; }

  let latDeg = degrees(lat);
  let lonDeg = degrees(lon);
  let spacing = 15.0;  // Grid every 15 degrees

  // Calculate per-pixel line width based on actual distance to this point
  // Formula: (2 * tan(fov/2) * distance) / screenHeight = world units per pixel
  let dist = length(hitPoint - u.eyePosition);
  let worldUnitsPerPixel = (2.0 * u.tanFov * dist) / u.resolution.y;
  let degreesPerPixel = worldUnitsPerPixel * (180.0 / 3.14159265);

  let pixelWidth = 3.0;  // Desired line width in screen pixels
  let width = pixelWidth * degreesPerPixel;

  // Longitude degrees shrink toward poles: 1° lon = cos(lat) * 1° lat in world space
  // So we need wider threshold in lon-degrees to get same screen width
  let lonWidth = width / max(cos(lat), 0.01);  // avoid division by zero at poles

  // Distance to nearest grid line (in degrees)
  let latLine = abs(fract(latDeg / spacing + 0.5) - 0.5) * spacing;
  let lonLine = abs(fract(lonDeg / spacing + 0.5) - 0.5) * spacing;

  // Antialiased edges: smoothstep from line center to edge
  // smoothstep(edge1, edge0, x) returns 1 when x < edge0, 0 when x > edge1
  let latFactor = 1.0 - smoothstep(width * 0.5, width, latLine);
  let lonFactor = 1.0 - smoothstep(lonWidth * 0.5, lonWidth, lonLine);
  let gridFactor = max(latFactor, lonFactor);

  if (gridFactor > 0.001) {
    let gridColor = vec3f(1.0, 1.0, 1.0);
    return vec4f(mix(color.rgb, gridColor, gridFactor * u.gridOpacity * 0.5), color.a);
  }
  return color;
}
