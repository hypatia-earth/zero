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
  logoPad: vec2f,         // padding for vec4 alignment
  // Built-in layer palette indices (16 slots)
  layerPaletteIndex: array<vec4<u32>, 4>,
  // Built-in layer palette ranges (8 slots x 2 floats packed as min/max pairs)
  layerPaletteRange: array<vec4<f32>, 4>,
  // User layer slots (32 max) - packed as vec4s for alignment
  userLayerOpacity: array<vec4<f32>, 8>,   // 32 opacity values
  userLayerDataReady: array<vec4<u32>, 8>, // 32 data ready flags
  // User layer palette indices (32 slots)
  userLayerPaletteIndex: array<vec4<u32>, 8>,
  // Dynamic param state (16 params max) - for per-param interpolation
  paramLerp: array<vec4<f32>, 4>,          // 16 lerp factors (0.0-1.0)
  paramReady: array<vec4<u32>, 4>,         // 16 data ready flags
  // Advection / rain particle uniforms
  advectionDt: f32,        // seconds between adjacent timesteps
  rainFadeDuration: f32,   // particle fade cycle in seconds
  rainGridSize: f32,       // base particle grid density
  advectionPad: f32,       // alignment padding
}

@group(0) @binding(0) var<uniform> u: Uniforms;

// User layer accessors (32 slots)
fn getUserLayerOpacity(index: u32) -> f32          { return u.userLayerOpacity[index / 4u][index % 4u]; }
fn getUserLayerDataReady(index: u32) -> bool       { return u.userLayerDataReady[index / 4u][index % 4u] != 0u; }
fn getUserLayerPaletteIndex(index: u32) -> u32     { return u.userLayerPaletteIndex[index / 4u][index % 4u]; }

// Built-in layer accessors (16 slots)
fn getLayerOpacity(index: u32) -> f32              { return u.layerOpacity[index / 4u][index % 4u]; }
fn isLayerDataReady(index: u32) -> bool            { return u.layerDataReady[index / 4u][index % 4u] != 0u; }
fn getLayerPaletteIndex(index: u32) -> u32         { return u.layerPaletteIndex[index / 4u][index % 4u]; }

// Palette range: min/max pair packed into vec4 (8 slots)
fn getLayerPaletteRange(index: u32) -> vec2f {
  let v = u.layerPaletteRange[index / 2u];
  if (index % 2u == 0u) { return v.xy; }
  return v.zw;
}

// Param accessors (16 slots)
fn getParamLerp(index: u32) -> f32                 { return u.paramLerp[index / 4u][index % 4u]; }
fn isParamReady(index: u32) -> bool                { return u.paramReady[index / 4u][index % 4u] != 0u; }
