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
  // Indices: earth=0, sun=1, graticule=2, cities=3, temp=4, rain=5, clouds=6, pressure=7, wind=8
  ['layerOpacity0', 'vec4f'],      // 176: layers 0-3 (earth, sun, graticule, cities)
  ['layerOpacity1', 'vec4f'],      // 192: layers 4-7 (temp, rain, clouds, pressure)
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
  ['cityFontScale', 'f32'],        // 0=indicators only, 0.5-1.0=text scale
  ['cityGlyphOffset', 'u32'],      // vec4 index where glyphs start in cityData buffer
  ['globeRadiusPx', 'f32'],        // earth apparent radius in CSS pixels (renderScale-independent)
  ['cityColorR', 'f32'],           // city label/indicator color (RGB)
  ['cityColorG', 'f32'],
  ['cityColorB', 'f32'],

  // Built-in layer palettes: 1 vec4u per layer = 4 palette slots each (16 layers)
  ['layerPalettes0', 'vec4u'],
  ['layerPalettes1', 'vec4u'],
  ['layerPalettes2', 'vec4u'],
  ['layerPalettes3', 'vec4u'],
  ['layerPalettes4', 'vec4u'],
  ['layerPalettes5', 'vec4u'],
  ['layerPalettes6', 'vec4u'],
  ['layerPalettes7', 'vec4u'],
  ['layerPalettes8', 'vec4u'],
  ['layerPalettes9', 'vec4u'],
  ['layerPalettes10', 'vec4u'],
  ['layerPalettes11', 'vec4u'],
  ['layerPalettes12', 'vec4u'],
  ['layerPalettes13', 'vec4u'],
  ['layerPalettes14', 'vec4u'],
  ['layerPalettes15', 'vec4u'],

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

  // userLayerPaletteRange: 8 x vec4f = 128 bytes (16 slots x 2 floats packed as min/max pairs)
  ['userLayerPaletteRange0', 'vec4f'],
  ['userLayerPaletteRange1', 'vec4f'],
  ['userLayerPaletteRange2', 'vec4f'],
  ['userLayerPaletteRange3', 'vec4f'],
  ['userLayerPaletteRange4', 'vec4f'],
  ['userLayerPaletteRange5', 'vec4f'],
  ['userLayerPaletteRange6', 'vec4f'],
  ['userLayerPaletteRange7', 'vec4f'],

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

  // paramSize: 4 x vec4u = 64 bytes (grid point count per param = t1 offset in combined buffer)
  ['paramSize0', 'vec4u'],  // params 0-3
  ['paramSize1', 'vec4u'],  // params 4-7
  ['paramSize2', 'vec4u'],  // params 8-11
  ['paramSize3', 'vec4u'],  // params 12-15

  // Rain particle uniforms
  ['rainFadeDuration', 'f32'],   // particle fade cycle in seconds (~1.0)
  ['rainDensity', 'f32'],        // items per px² (0.01 = 1 per 10×10)
  ['rainSizePx', 'f32'],         // particle radius in screen pixels
  ['rainMinMm', 'f32'],          // minimum precipitation (mm) to render
  ['backfaceKiller', 'f32'],     // 1.0 = an opaque-coverage layer (earth/temp) is enabled → skip back-hemisphere rendering for transparent layers
  ['rainAnimTime', 'f32'],       // accumulated animation time (seconds, from frameDelta)

  // Cloud layer uniforms
  ['cloudsBrightness', 'f32'],      // base cloud brightness (white point)
  ['cloudsShadowStrength', 'f32'],  // shadow-edge darkening factor
  ['cloudsEdgeBrightness', 'f32'],  // sun-facing edge brightness boost
  ['cloudsCoverageMin', 'f32'],     // coverage % threshold below which = "no cloud"
  ['cloudsNoiseStrength', 'f32'],   // Perlin brightness modulation amplitude
  ['cloudsNoiseSpeed', 'f32'],      // noise drift oscillation speed
  ['cloudsWarmthTint', 'f32'],      // golden hour tint strength (0 = none, 1 = full)
  ['cloudsEdgeSteps', 'f32'],       // edge detection depth (1-5 cells)
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
  cityFontScale: number;
  cityGlyphOffset: number;
  globeRadiusPx: number;
  cityColorR: number;
  cityColorG: number;
  cityColorB: number;
  // Built-in layer palettes (1 vec4u per layer = 4 palette slots each)
  layerPalettes0: number;
  layerPalettes1: number;
  layerPalettes2: number;
  layerPalettes3: number;
  layerPalettes4: number;
  layerPalettes5: number;
  layerPalettes6: number;
  layerPalettes7: number;
  layerPalettes8: number;
  layerPalettes9: number;
  layerPalettes10: number;
  layerPalettes11: number;
  layerPalettes12: number;
  layerPalettes13: number;
  layerPalettes14: number;
  layerPalettes15: number;
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
  // User layer palette ranges (8 vec4fs = 16 slots x 2 floats)
  userLayerPaletteRange0: number;
  userLayerPaletteRange1: number;
  userLayerPaletteRange2: number;
  userLayerPaletteRange3: number;
  userLayerPaletteRange4: number;
  userLayerPaletteRange5: number;
  userLayerPaletteRange6: number;
  userLayerPaletteRange7: number;
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
  // Per-param grid point count (t1 offset in combined buffer)
  paramSize0: number;
  paramSize1: number;
  paramSize2: number;
  paramSize3: number;
  // Rain particle uniforms
  rainFadeDuration: number;
  rainDensity: number;
  rainSizePx: number;
  rainMinMm: number;
  backfaceKiller: number;
  rainAnimTime: number;
  // Cloud layer uniforms
  cloudsBrightness: number;
  cloudsShadowStrength: number;
  cloudsEdgeBrightness: number;
  cloudsCoverageMin: number;
  cloudsNoiseStrength: number;
  cloudsNoiseSpeed: number;
  cloudsWarmthTint: number;
  cloudsEdgeSteps: number;
};

/** Byte offset of component `index` within a packed vec4 array starting at `base` */
function packedVec4Offset(base: number, index: number): number {
  return base + Math.floor(index / 4) * 16 + (index % 4) * 4;
}

// Built-in layer offsets (16 slots, packed as 4 x vec4)
export const getLayerOpacityOffset       = (index: number) => packedVec4Offset(U.layerOpacity0, index);
export const getLayerDataReadyOffset     = (index: number) => packedVec4Offset(U.layerDataReady0, index);
/** Byte offset for layerPalettes[layerIndex][slot] — one vec4u per layer, 4 slots each */
export const getLayerPaletteIndexOffset  = (layerIndex: number, slot: number) =>
  U.layerPalettes0 + layerIndex * 16 + slot * 4;

/** Palette range: 2 x f32 pair per slot, packed into vec4s */
export const getLayerPaletteRangeOffset  = (index: number) => packedVec4Offset(U.layerPaletteRange0, index * 2);

// User layer offsets (32 slots, packed as 8 x vec4)
export const getUserLayerOpacityOffset      = (index: number) => packedVec4Offset(U.userLayerOpacity0, index);
export const getUserLayerDataReadyOffset    = (index: number) => packedVec4Offset(U.userLayerDataReady0, index);
export const getUserLayerPaletteIndexOffset = (index: number) => packedVec4Offset(U.userLayerPaletteIndex0, index);

/** User layer palette range: 2 x f32 pair per slot, packed into vec4s */
export const getUserLayerPaletteRangeOffset = (index: number) => packedVec4Offset(U.userLayerPaletteRange0, index * 2);

// Param offsets (16 slots, packed as 4 x vec4)
export const getParamLerpOffset  = (index: number) => packedVec4Offset(U.paramLerp0, index);
export const getParamReadyOffset = (index: number) => packedVec4Offset(U.paramReady0, index);
export const getParamDtOffset    = (index: number) => packedVec4Offset(U.paramDt0, index);
export const getParamSizeOffset  = (index: number) => packedVec4Offset(U.paramSize0, index);

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
