// Logo layer - displays Hypatia logo as screen-space sprite when all layers are off

fn blendLogo(color: vec4f, fragPos: vec2f) -> vec4f {
  // Logo opacity computed in JS from all layer opacities
  if (u.logoOpacity < 0.01) {
    return color;
  }

  // Screen-space UV (0,0 at top-left, 1,1 at bottom-right)
  let screenUV = fragPos / u.resolution;

  // Center the logo, scale to ~30% of screen height
  let aspect = u.resolution.x / u.resolution.y;
  let logoSize = 0.3;  // 30% of screen height

  // Adjust for aspect ratio (logo is square)
  let centeredUV = vec2f(
    (screenUV.x - 0.5) * aspect / logoSize + 0.5,
    (screenUV.y - 0.5) / logoSize + 0.5
  );

  // Only sample if within logo bounds
  if (centeredUV.x < 0.0 || centeredUV.x > 1.0 || centeredUV.y < 0.0 || centeredUV.y > 1.0) {
    return color;
  }

  let logoColor = textureSampleLevel(logoTexture, logoSampler, centeredUV, 0.0);

  // Blend based on luminosity (logo is white/gray on black background)
  let luminosity = logoColor.r;  // grayscale, so r=g=b
  let blendAlpha = luminosity * u.logoOpacity;
  return vec4f(mix(color.rgb, vec3f(1.0), blendAlpha), 1.0);
}
