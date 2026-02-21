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
  ['sunPad', 'vec3f'],             // 100: pad for vec3f alignment
  ['sunDirection', 'vec3f'],       // 112
  ['sunDirPad', 'f32'],            // 124
  ['sunCoreRadius', 'f32'],        // 128
  ['sunGlowRadius', 'f32'],        // 132
  ['sunRadiiPad', 'vec2f'],        // 136: pad for vec3f alignment
  ['sunCoreColor', 'vec3f'],       // 144
  ['sunCoreColorPad', 'f32'],      // 156
  ['sunGlowColor', 'vec3f'],       // 160
  ['sunGlowColorPad', 'f32'],      // 172

  // Built-in layer opacity array (16 slots = 4 x vec4f)
  // Indices: earth=0, sun=1, grid=2, temp=3, rain=4, pressure=5, wind=6
  ['layerOpacity0', 'vec4f'],      // 192: layers 0-3 (earth, sun, grid, temp)
  ['layerOpacity1', 'vec4f'],      // 208: layers 4-7 (rain, pressure, wind, -)
  ['layerOpacity2', 'vec4f'],      // 224: layers 8-11 (reserved)
  ['layerOpacity3', 'vec4f'],      // 240: layers 12-15 (reserved)

  // Built-in layer data ready flags (16 slots = 4 x vec4u)
  ['layerDataReady0', 'vec4u'],    // 256: layers 0-3
  ['layerDataReady1', 'vec4u'],    // 272: layers 4-7
  ['layerDataReady2', 'vec4u'],    // 288: layers 8-11
  ['layerDataReady3', 'vec4u'],    // 304: layers 12-15

  ['graticuleFontSize', 'f32'],         // 320
  ['graticuleLabelMaxRadius', 'f32'],   // 340
  ['graticuleLineWidth', 'f32'],        // 344
  ['paletteCount', 'u32'],         // total palettes in texture
  ['paletteStepped', 'u32'],       // bitmask — bit i = 1 means palette i is stepped
  ['logoOpacity', 'f32'],
  ['logoPad', 'vec2f'],            // pad for vec4 alignment

  // Built-in layer palette index array (16 slots = 4 x vec4u)
  ['layerPaletteIndex0', 'vec4u'],
  ['layerPaletteIndex1', 'vec4u'],
  ['layerPaletteIndex2', 'vec4u'],
  ['layerPaletteIndex3', 'vec4u'],

  // Built-in layer palette range array (8 slots x 2 floats = 4 x vec4f)
  // Packed as (layer0_min, layer0_max, layer1_min, layer1_max) per vec4f
  ['layerPaletteRange0', 'vec4f'],
  ['layerPaletteRange1', 'vec4f'],
  ['layerPaletteRange2', 'vec4f'],
  ['layerPaletteRange3', 'vec4f'],

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

  // userLayerPaletteIndex: 8 x vec4u = 128 bytes (indices 0-31)
  ['userLayerPaletteIndex0', 'vec4u'],
  ['userLayerPaletteIndex1', 'vec4u'],
  ['userLayerPaletteIndex2', 'vec4u'],
  ['userLayerPaletteIndex3', 'vec4u'],
  ['userLayerPaletteIndex4', 'vec4u'],
  ['userLayerPaletteIndex5', 'vec4u'],
  ['userLayerPaletteIndex6', 'vec4u'],
  ['userLayerPaletteIndex7', 'vec4u'],

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

  // paramDt: 4 x vec4f = 64 bytes (slot spacing in seconds per param)
  ['paramDt0', 'vec4f'],    // params 0-3
  ['paramDt1', 'vec4f'],    // params 4-7
  ['paramDt2', 'vec4f'],    // params 8-11
  ['paramDt3', 'vec4f'],    // params 12-15

  // Rain particle uniforms
  ['rainFadeDuration', 'f32'],   // particle fade cycle in seconds (~1.0)
  ['rainDensity', 'f32'],        // items per px² (0.01 = 1 per 10×10)
  ['rainSizePx', 'f32'],         // particle radius in screen pixels
  ['rainMinMm', 'f32'],          // minimum precipitation (mm) to render
  ['rainBackFace', 'f32'],       // 1.0 = render rain on back hemisphere
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
  // Built-in layer arrays (4 vec4s each = 16 slots)
  layerOpacity0: number;
  layerOpacity1: number;
  layerOpacity2: number;
  layerOpacity3: number;
  layerDataReady0: number;
  layerDataReady1: number;
  layerDataReady2: number;
  layerDataReady3: number;
  graticuleFontSize: number;
  graticuleLabelMaxRadius: number;
  graticuleLineWidth: number;
  paletteCount: number;
  paletteStepped: number;
  logoOpacity: number;
  logoPad: number;
  // Built-in layer palette arrays
  layerPaletteIndex0: number;
  layerPaletteIndex1: number;
  layerPaletteIndex2: number;
  layerPaletteIndex3: number;
  layerPaletteRange0: number;
  layerPaletteRange1: number;
  layerPaletteRange2: number;
  layerPaletteRange3: number;
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
  // User layer palette indices (8 vec4us = 32 slots)
  userLayerPaletteIndex0: number;
  userLayerPaletteIndex1: number;
  userLayerPaletteIndex2: number;
  userLayerPaletteIndex3: number;
  userLayerPaletteIndex4: number;
  userLayerPaletteIndex5: number;
  userLayerPaletteIndex6: number;
  userLayerPaletteIndex7: number;
  // Dynamic param state (16 params max)
  paramLerp0: number;
  paramLerp1: number;
  paramLerp2: number;
  paramLerp3: number;
  paramReady0: number;
  paramReady1: number;
  paramReady2: number;
  paramReady3: number;
  // Per-param slot spacing (seconds)
  paramDt0: number;
  paramDt1: number;
  paramDt2: number;
  paramDt3: number;
  // Rain particle uniforms
  rainFadeDuration: number;
  rainDensity: number;
  rainSizePx: number;
  rainMinMm: number;
  rainBackFace: number;
};

/** Byte offset of component `index` within a packed vec4 array starting at `base` */
function packedVec4Offset(base: number, index: number): number {
  return base + Math.floor(index / 4) * 16 + (index % 4) * 4;
}

// Built-in layer offsets (16 slots, packed as 4 x vec4)
export const getLayerOpacityOffset       = (index: number) => packedVec4Offset(U.layerOpacity0, index);
export const getLayerDataReadyOffset     = (index: number) => packedVec4Offset(U.layerDataReady0, index);
export const getLayerPaletteIndexOffset  = (index: number) => packedVec4Offset(U.layerPaletteIndex0, index);

/** Palette range: 2 x f32 pair per slot, packed into vec4s */
export const getLayerPaletteRangeOffset  = (index: number) => packedVec4Offset(U.layerPaletteRange0, index * 2);

// User layer offsets (32 slots, packed as 8 x vec4)
export const getUserLayerOpacityOffset      = (index: number) => packedVec4Offset(U.userLayerOpacity0, index);
export const getUserLayerDataReadyOffset    = (index: number) => packedVec4Offset(U.userLayerDataReady0, index);
export const getUserLayerPaletteIndexOffset = (index: number) => packedVec4Offset(U.userLayerPaletteIndex0, index);

// Param offsets (16 slots, packed as 4 x vec4)
export const getParamLerpOffset  = (index: number) => packedVec4Offset(U.paramLerp0, index);
export const getParamReadyOffset = (index: number) => packedVec4Offset(U.paramReady0, index);
export const getParamDtOffset    = (index: number) => packedVec4Offset(U.paramDt0, index);

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
    layerOpacity0: 176,  // After sunGlowColorPad (172 + 4 = 176)
    layerDataReady0: 240, // After layerOpacity3 (176 + 64 = 240)
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
