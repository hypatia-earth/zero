// Sun layer - sun disc and glow rendering

fn blendSun(color: vec4f, fragCoord: vec2f) -> vec4f {
  if (u.sunOpacity < 0.01) { return color; }

  // Project sun direction to screen space
  let aspect = u.resolution.x / u.resolution.y;
  let forward = -normalize(u.eyePosition);
  let worldUp = vec3f(0.0, 1.0, 0.0);
  let right = normalize(cross(forward, worldUp));
  let up = cross(right, forward);

  // Sun direction relative to camera
  let sunLocal = vec3f(
    dot(u.sunDirection, right),
    dot(u.sunDirection, up),
    dot(u.sunDirection, forward)
  );

  // Only render if sun is in front of camera
  if (sunLocal.z <= 0.0) { return color; }

  // Project to screen coords (normalized, no aspect correction yet)
  let sunScreen = vec2f(
    sunLocal.x / (sunLocal.z * u.tanFov),
    sunLocal.y / (sunLocal.z * u.tanFov)
  );

  // Current pixel in NDC
  let pixelNDC = vec2f(
    (fragCoord.x / u.resolution.x) * 2.0 - 1.0,
    1.0 - (fragCoord.y / u.resolution.y) * 2.0
  );

  // Compute difference, then correct X for aspect ratio
  let diff = vec2f(
    (pixelNDC.x - sunScreen.x) * aspect,
    pixelNDC.y - sunScreen.y
  );

  // Distance in screen space (perfect circle)
  let dist = length(diff);

  // Core disc
  if (dist < u.sunCoreRadius) {
    return vec4f(mix(color.rgb, u.sunCoreColor, u.sunOpacity), 1.0);
  }

  // Glow falloff - directly outside core
  if (dist < u.sunGlowRadius) {
    let t = 1.0 - (dist - u.sunCoreRadius) / (u.sunGlowRadius - u.sunCoreRadius);
    let glow = u.sunGlowColor * t * t * 0.4 * u.sunOpacity;
    return vec4f(color.rgb + glow, 1.0);
  }

  return color;
}
