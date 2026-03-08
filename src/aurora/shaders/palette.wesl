// Palette sampling — shared palette array (256xN texture, one row per palette)

import package::aurora::shaders::layer_helpers::u;

@group(0) @binding(13) var paletteArray: texture_2d<f32>;
@group(0) @binding(14) var paletteSampler: sampler;

// Universal palette sampling — works for all palettes (stepped or smooth)
fn samplePalette(t: f32, paletteIndex: u32) -> vec4f {
  let tc = clamp(t, 0.0, 1.0);
  let stepped = (u.paletteStepped >> paletteIndex) & 1u;
  if (stepped == 1u) {
    let tx = u32(clamp(tc * 256.0, 0.0, 255.0));
    return textureLoad(paletteArray, vec2u(tx, paletteIndex), 0);
  }
  let v = (f32(paletteIndex) + 0.5) / f32(u.paletteCount);
  return textureSampleLevel(paletteArray, paletteSampler, vec2f(tc, v), 0.0);
}
