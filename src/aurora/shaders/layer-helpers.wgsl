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
  gridFontSize: f32,      // font size in screen pixels for grid labels
  gridLabelMaxRadius: f32, // max globe radius (px) before labels shrink
  gridLineWidth: f32,     // line width in screen pixels
  tempPaletteRange: vec2f, // min/max temperature values for palette mapping (Celsius)
  logoOpacity: f32,       // computed from all layer opacities
  logoPad: f32,           // padding for alignment
  // User layer slots (32 max) - packed as vec4s for alignment
  userLayerOpacity: array<vec4<f32>, 8>,   // 32 opacity values
  userLayerDataReady: array<vec4<u32>, 8>, // 32 data ready flags
  // Dynamic param state (16 params max) - for per-param interpolation
  paramLerp: array<vec4<f32>, 4>,          // 16 lerp factors (0.0-1.0)
  paramReady: array<vec4<u32>, 4>,         // 16 data ready flags
}

@group(0) @binding(0) var<uniform> u: Uniforms;

// Helper to get user layer opacity by index
fn getUserLayerOpacity(index: u32) -> f32 {
  let vecIdx = index / 4u;
  let compIdx = index % 4u;
  let v = u.userLayerOpacity[vecIdx];
  switch compIdx {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

fn getUserLayerDataReady(index: u32) -> bool {
  let vecIdx = index / 4u;
  let compIdx = index % 4u;
  let v = u.userLayerDataReady[vecIdx];
  switch compIdx {
    case 0u: { return v.x != 0u; }
    case 1u: { return v.y != 0u; }
    case 2u: { return v.z != 0u; }
    default: { return v.w != 0u; }
  }
}

// Get built-in layer opacity by index (0-15)
fn getLayerOpacity(index: u32) -> f32 {
  let vecIdx = index / 4u;
  let compIdx = index % 4u;
  let v = u.layerOpacity[vecIdx];
  switch compIdx {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

// Check if built-in layer data is ready by index (0-15)
fn isLayerDataReady(index: u32) -> bool {
  let vecIdx = index / 4u;
  let compIdx = index % 4u;
  let v = u.layerDataReady[vecIdx];
  switch compIdx {
    case 0u: { return v.x != 0u; }
    case 1u: { return v.y != 0u; }
    case 2u: { return v.z != 0u; }
    default: { return v.w != 0u; }
  }
}

// Get param lerp factor by index (0-15)
fn getParamLerp(index: u32) -> f32 {
  let vecIdx = index / 4u;
  let compIdx = index % 4u;
  let v = u.paramLerp[vecIdx];
  switch compIdx {
    case 0u: { return v.x; }
    case 1u: { return v.y; }
    case 2u: { return v.z; }
    default: { return v.w; }
  }
}

// Check if param data is ready by index (0-15)
fn isParamReady(index: u32) -> bool {
  let vecIdx = index / 4u;
  let compIdx = index % 4u;
  let v = u.paramReady[vecIdx];
  switch compIdx {
    case 0u: { return v.x != 0u; }
    case 1u: { return v.y != 0u; }
    case 2u: { return v.z != 0u; }
    default: { return v.w != 0u; }
  }
}
