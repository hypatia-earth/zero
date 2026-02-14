/**
 * Globe Uniform Buffer Layout
 *
 * Single source of truth for uniform struct layout.
 * Must match the WGSL struct in main-template.wgsl exactly.
 */

import { layoutStruct, type StructLayout } from './uniform-struct';

/**
 * Globe uniform struct layout - matches main-template.wgsl Uniforms struct
 *
 * Note: Fields are in WGSL declaration order. The layoutStruct function
 * calculates correct offsets including alignment padding.
 */
export const GLOBE_UNIFORMS: StructLayout = layoutStruct([
  // View/Camera (64 + 16 + 16 = 96 bytes)
  ['viewProjInverse', 'mat4x4f'],  // 0: 64 bytes
  ['eyePosition', 'vec3f'],        // 64: 12 bytes + 4 pad (vec3f is 16-aligned)
  ['eyePad', 'f32'],               // 76: explicit pad in WGSL
  ['resolution', 'vec2f'],         // 80: 8 bytes
  ['tanFov', 'f32'],               // 88: 4 bytes
  ['resPad', 'f32'],               // 92: 4 bytes

  // Time & Sun (16 + 16 + 16 + 16 + 16 = 80 bytes)
  ['time', 'f32'],                 // 96
  ['sunOpacity', 'f32'],           // 100
  ['sunPad', 'vec2f'],             // 104: pad for vec3f alignment
  ['sunDirection', 'vec3f'],       // 112
  ['sunDirPad', 'f32'],            // 124
  ['sunCoreRadius', 'f32'],        // 128
  ['sunGlowRadius', 'f32'],        // 132
  ['sunRadiiPad', 'vec2f'],        // 136: pad for vec3f alignment
  ['sunCoreColor', 'vec3f'],       // 144
  ['sunCoreColorPad', 'f32'],      // 156
  ['sunGlowColor', 'vec3f'],       // 160
  ['sunGlowColorPad', 'f32'],      // 172

  // Layer controls (tightly packed f32/u32)
  ['gridEnabled', 'u32'],          // 176
  ['gridOpacity', 'f32'],          // 180
  ['earthOpacity', 'f32'],         // 184
  ['tempOpacity', 'f32'],          // 188
  ['rainOpacity', 'f32'],          // 192
  ['tempDataReady', 'u32'],        // 196
  ['rainDataReady', 'u32'],        // 200
  ['tempLerp', 'f32'],             // 204
  ['tempLoadedPoints', 'u32'],     // 208
  ['tempSlot0', 'u32'],            // 212
  ['tempSlot1', 'u32'],            // 216
  ['gridFontSize', 'f32'],         // 220
  ['gridLabelMaxRadius', 'f32'],   // 224
  ['gridLineWidth', 'f32'],        // 228: line width in screen pixels
  ['tempPaletteRange', 'vec2f'],   // 232

  ['logoOpacity', 'f32'],          // 240: computed from all layer opacities
  ['logoPad', 'f32'],              // 244: padding for alignment

  // User layer slots (32 max) - packed as vec4s for alignment
  // userLayerOpacity: 8 x vec4f = 128 bytes (indices 0-31)
  ['userLayerOpacity0', 'vec4f'],  // 272: user layers 0-3
  ['userLayerOpacity1', 'vec4f'],  // 288: user layers 4-7
  ['userLayerOpacity2', 'vec4f'],  // 304: user layers 8-11
  ['userLayerOpacity3', 'vec4f'],  // 320: user layers 12-15
  ['userLayerOpacity4', 'vec4f'],  // 336: user layers 16-19
  ['userLayerOpacity5', 'vec4f'],  // 352: user layers 20-23
  ['userLayerOpacity6', 'vec4f'],  // 368: user layers 24-27
  ['userLayerOpacity7', 'vec4f'],  // 384: user layers 28-31

  // userLayerDataReady: 8 x vec4u = 128 bytes (indices 0-31)
  ['userLayerDataReady0', 'vec4u'], // 400: user layers 0-3
  ['userLayerDataReady1', 'vec4u'], // 416: user layers 4-7
  ['userLayerDataReady2', 'vec4u'], // 432: user layers 8-11
  ['userLayerDataReady3', 'vec4u'], // 448: user layers 12-15
  ['userLayerDataReady4', 'vec4u'], // 464: user layers 16-19
  ['userLayerDataReady5', 'vec4u'], // 480: user layers 20-23
  ['userLayerDataReady6', 'vec4u'], // 496: user layers 24-27
  ['userLayerDataReady7', 'vec4u'], // 512: user layers 28-31

  // Dynamic param state (16 params max) - for per-param interpolation
  // paramLerp: 4 x vec4f = 64 bytes (lerp factors 0.0-1.0)
  ['paramLerp0', 'vec4f'],   // 528: params 0-3
  ['paramLerp1', 'vec4f'],   // 544: params 4-7
  ['paramLerp2', 'vec4f'],   // 560: params 8-11
  ['paramLerp3', 'vec4f'],   // 576: params 12-15

  // paramReady: 4 x vec4u = 64 bytes (data ready flags)
  ['paramReady0', 'vec4u'],  // 592: params 0-3
  ['paramReady1', 'vec4u'],  // 608: params 4-7
  ['paramReady2', 'vec4u'],  // 624: params 8-11
  ['paramReady3', 'vec4u'],  // 640: params 12-15
]);

// Strongly typed offsets - TypeScript knows all field names exist
export const U = GLOBE_UNIFORMS.offsets as {
  viewProjInverse: number;
  eyePosition: number;
  eyePad: number;
  resolution: number;
  tanFov: number;
  resPad: number;
  time: number;
  sunOpacity: number;
  sunPad: number;
  sunDirection: number;
  sunDirPad: number;
  sunCoreRadius: number;
  sunGlowRadius: number;
  sunRadiiPad: number;
  sunCoreColor: number;
  sunCoreColorPad: number;
  sunGlowColor: number;
  sunGlowColorPad: number;
  gridEnabled: number;
  gridOpacity: number;
  earthOpacity: number;
  tempOpacity: number;
  rainOpacity: number;
  tempDataReady: number;
  rainDataReady: number;
  tempLerp: number;
  tempLoadedPoints: number;
  tempSlot0: number;
  tempSlot1: number;
  gridFontSize: number;
  gridLabelMaxRadius: number;
  gridLineWidth: number;
  tempPaletteRange: number;
  logoOpacity: number;
  logoPad: number;
  // User layer arrays (8 vec4s each = 32 slots)
  userLayerOpacity0: number;
  userLayerOpacity1: number;
  userLayerOpacity2: number;
  userLayerOpacity3: number;
  userLayerOpacity4: number;
  userLayerOpacity5: number;
  userLayerOpacity6: number;
  userLayerOpacity7: number;
  userLayerDataReady0: number;
  userLayerDataReady1: number;
  userLayerDataReady2: number;
  userLayerDataReady3: number;
  userLayerDataReady4: number;
  userLayerDataReady5: number;
  userLayerDataReady6: number;
  userLayerDataReady7: number;
  // Dynamic param state (16 params max)
  paramLerp0: number;
  paramLerp1: number;
  paramLerp2: number;
  paramLerp3: number;
  paramReady0: number;
  paramReady1: number;
  paramReady2: number;
  paramReady3: number;
};

/** Get uniform buffer offset for user layer opacity by index (0-31) */
export function getUserLayerOpacityOffset(index: number): number {
  const vecIndex = Math.floor(index / 4);
  const compIndex = index % 4;
  const baseOffset = U.userLayerOpacity0 + vecIndex * 16;
  return baseOffset + compIndex * 4;
}

/** Get uniform buffer offset for user layer dataReady by index (0-31) */
export function getUserLayerDataReadyOffset(index: number): number {
  const vecIndex = Math.floor(index / 4);
  const compIndex = index % 4;
  const baseOffset = U.userLayerDataReady0 + vecIndex * 16;
  return baseOffset + compIndex * 4;
}

/** Get uniform buffer offset for param lerp by index (0-15) */
export function getParamLerpOffset(index: number): number {
  const vecIndex = Math.floor(index / 4);
  const compIndex = index % 4;
  const baseOffset = U.paramLerp0 + vecIndex * 16;
  return baseOffset + compIndex * 4;
}

/** Get uniform buffer offset for param ready by index (0-15) */
export function getParamReadyOffset(index: number): number {
  const vecIndex = Math.floor(index / 4);
  const compIndex = index % 4;
  const baseOffset = U.paramReady0 + vecIndex * 16;
  return baseOffset + compIndex * 4;
}

// Expected size - can be used for buffer allocation
export const UNIFORM_BUFFER_SIZE = GLOBE_UNIFORMS.size;

// Validation: run at startup in dev mode
export function validateGlobeUniforms(): void {
  const expected: Record<string, number> = {
    viewProjInverse: 0,
    eyePosition: 64,
    resolution: 80,
    time: 96,
    sunDirection: 112,
    sunCoreColor: 144,
    sunGlowColor: 160,
    gridEnabled: 176,
    tempPaletteRange: 232,
    logoOpacity: 240,
  };

  const errors: string[] = [];
  for (const [name, expectedOffset] of Object.entries(expected)) {
    const actual = GLOBE_UNIFORMS.offsets[name];
    if (actual !== expectedOffset) {
      errors.push(`${name}: expected ${expectedOffset}, got ${actual}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Uniform layout mismatch!\n${errors.join('\n')}`);
  }
}
