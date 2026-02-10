// Joker Layer Shader - Solid color overlay for testing declarative system

fn blendJoker(color: vec3f, point: vec3f) -> vec3f {
  // Get uniforms from structured buffer
  let jokerColor = uniforms.jokerColor;
  let jokerOpacity = uniforms.jokerOpacity;
  let jokerEnabled = uniforms.jokerEnabled;

  if (jokerEnabled < 0.5) {
    return color;
  }

  // Simple alpha blend
  return mix(color, jokerColor, jokerOpacity);
}
