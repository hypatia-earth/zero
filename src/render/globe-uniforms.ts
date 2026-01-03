/**
 * Globe Uniform Buffer Layout
 *
 * Single source of truth for uniform struct layout.
 * Must match the WGSL struct in main.wgsl exactly.
 */

import { layoutStruct, type StructLayout } from './uniform-struct';

/**
 * Globe uniform struct layout - matches main.wgsl Uniforms struct
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

  // Additional weather layers
  ['cloudsOpacity', 'f32'],        // 240
  ['humidityOpacity', 'f32'],      // 244
  ['windOpacity', 'f32'],          // 248
  ['cloudsDataReady', 'u32'],      // 252
  ['humidityDataReady', 'u32'],    // 256
  ['windDataReady', 'u32'],        // 260
  ['logoOpacity', 'f32'],          // 264: computed from all layer opacities
  ['logoPad', 'f32'],              // 268: padding for alignment
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
  cloudsOpacity: number;
  humidityOpacity: number;
  windOpacity: number;
  cloudsDataReady: number;
  humidityDataReady: number;
  windDataReady: number;
  logoOpacity: number;
  logoPad: number;
};

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
    cloudsOpacity: 240,
    logoOpacity: 264,
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
