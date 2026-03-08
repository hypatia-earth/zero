// Layer helper functions - must be included before layer shaders
// Extracted from main-template.wgsl to support shader composition order

struct Uniforms {
  viewProjInverse: mat4x4f,  // 64 bytes
  eyePosition: vec3f,         // 12 + 4 pad = 16 bytes
  eyePad: f32,
  resolution: vec2f,          // 8 bytes
  tanFov: f32,                // 4 bytes
  resPad: f32,                // 4 bytes pad = 16 bytes total
  time: f32,                  // 4 bytes
  sunPad: vec3f,              // 12 bytes pad for vec3f alignment
  sunDirection: vec3f,        // 12 + 4 pad = 16 bytes
  sunDirPad: f32,
  sunCoreRadius: f32,         // 4 bytes
  sunGlowRadius: f32,         // 4 bytes
  sunRadiiPad: vec2f,         // 8 bytes pad = 16 bytes
  sunCoreColor: vec3f,        // 12 + 4 pad = 16 bytes
  sunCoreColorPad: f32,
  sunGlowColor: vec3f,        // 12 + 4 pad = 16 bytes
  sunGlowColorPad: f32,
  // Built-in layer arrays (16 slots each)
  // Indices: earth=0, sun=1, grid=2, temp=3, rain=4, pressure=5, wind=6
  layerOpacity: array<vec4<f32>, 4>,     // 16 opacity values (4 vec4s)
  layerDataReady: array<vec4<u32>, 4>,   // 16 data ready flags (4 vec4s)
  graticuleFontSize: f32,      // font size in screen pixels for graticule labels
  graticuleLabelMaxRadius: f32, // max globe radius (px) before labels shrink
  graticuleLineWidth: f32,     // line width in screen pixels
  paletteCount: u32,      // total number of palettes in array
  paletteStepped: u32, // bitmask — bit i = 1 means palette i is stepped
  logoOpacity: f32,       // computed from all layer opacities
  cityFontScale: f32,     // 0=indicators only, 0.5-1.0=text scale
  cityGlyphOffset: u32,   // vec4 index where glyphs start in cityData buffer
  // Built-in layer palettes: 1 vec4u per layer = 4 palette slots each
  layerPalettes: array<vec4<u32>, 16>,
  // Built-in layer palette ranges (8 slots x 2 floats packed as min/max pairs)
  layerPaletteRange: array<vec4<f32>, 4>,
  // User layer slots (32 max) - packed as vec4s for alignment
  userLayerOpacity: array<vec4<f32>, 8>,   // 32 opacity values
  userLayerDataReady: array<vec4<u32>, 8>, // 32 data ready flags
  // User layer palette indices (32 slots)
  userLayerPaletteIndex: array<vec4<u32>, 8>,
  // User layer palette ranges (16 slots x 2 floats packed as min/max pairs)
  userLayerPaletteRange: array<vec4<f32>, 8>,
  // Dynamic param state (16 params max) - for per-param interpolation
  paramLerp: array<vec4<f32>, 4>,          // 16 lerp factors (0.0-1.0)
  paramReady: array<vec4<u32>, 4>,         // 16 data ready flags
  paramDt: array<vec4<f32>, 4>,            // 16 slot spacings (seconds)
  paramSize: array<vec4<u32>, 4>,          // 16 grid point counts (t1 offset)
  // Rain particle uniforms
  rainFadeDuration: f32,   // particle fade cycle in seconds
  rainDensity: f32,        // items per px² (0.01 = 1 per 10×10)
  rainSizePx: f32,         // particle radius in screen pixels
  rainMinMm: f32,          // minimum precipitation (mm) to render
  rainBackFace: f32,       // 1.0 = render rain on back hemisphere
  rainAnimTime: f32,       // accumulated animation time (seconds, from frameDelta)
}

@group(0) @binding(0) var<uniform> u: Uniforms;

// User layer accessors (32 slots)
fn getUserLayerOpacity(index: u32) -> f32          { return u.userLayerOpacity[index / 4u][index % 4u]; }
fn getUserLayerDataReady(index: u32) -> bool       { return u.userLayerDataReady[index / 4u][index % 4u] != 0u; }
fn getUserLayerPaletteIndex(index: u32) -> u32     { return u.userLayerPaletteIndex[index / 4u][index % 4u]; }

// User layer palette range: min/max pair packed into vec4 (16 slots)
fn getUserLayerPaletteRange(index: u32) -> vec2f {
  let v = u.userLayerPaletteRange[index / 2u];
  if (index % 2u == 0u) { return v.xy; }
  return v.zw;
}

// Built-in layer accessors (16 slots)
fn getLayerOpacity(index: u32) -> f32              { return u.layerOpacity[index / 4u][index % 4u]; }
fn isLayerDataReady(index: u32) -> bool            { return u.layerDataReady[index / 4u][index % 4u] != 0u; }
fn getLayerPaletteIndex(layer: u32, slot: u32) -> u32 { return u.layerPalettes[layer][slot]; }

// Palette range: min/max pair packed into vec4 (8 slots)
fn getLayerPaletteRange(index: u32) -> vec2f {
  let v = u.layerPaletteRange[index / 2u];
  if (index % 2u == 0u) { return v.xy; }
  return v.zw;
}

// Param accessors (16 slots)
fn getParamLerp(index: u32) -> f32                 { return u.paramLerp[index / 4u][index % 4u]; }
fn isParamReady(index: u32) -> bool                { return u.paramReady[index / 4u][index % 4u] != 0u; }
fn getParamDt(index: u32) -> f32                   { return u.paramDt[index / 4u][index % 4u]; }
fn getParamSize(index: u32) -> u32                 { return u.paramSize[index / 4u][index % 4u]; }
