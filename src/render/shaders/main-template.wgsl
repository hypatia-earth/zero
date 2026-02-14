// Globe shader template - composed by ShaderComposer
// This file is used when USE_DECLARATIVE_LAYERS is enabled.
// The marker {{SURFACE_BLEND_CALLS}} is replaced with layer blend calls.

struct Uniforms {
  viewProjInverse: mat4x4f,  // 64 bytes
  eyePosition: vec3f,         // 12 + 4 pad = 16 bytes
  eyePad: f32,
  resolution: vec2f,          // 8 bytes
  tanFov: f32,                // 4 bytes
  resPad: f32,                // 4 bytes pad = 16 bytes total
  time: f32,                  // 4 bytes
  sunOpacity: f32,            // 4 bytes (replaces sunEnabled)
  sunPad: vec2f,              // 8 bytes pad for vec3f alignment
  sunDirection: vec3f,        // 12 + 4 pad = 16 bytes
  sunDirPad: f32,
  sunCoreRadius: f32,         // 4 bytes
  sunGlowRadius: f32,         // 4 bytes
  sunRadiiPad: vec2f,         // 8 bytes pad = 16 bytes
  sunCoreColor: vec3f,        // 12 + 4 pad = 16 bytes
  sunCoreColorPad: f32,
  sunGlowColor: vec3f,        // 12 + 4 pad = 16 bytes
  sunGlowColorPad: f32,
  gridEnabled: u32,           // remaining fields tightly packed
  gridOpacity: f32,
  earthOpacity: f32,
  tempOpacity: f32,
  rainOpacity: f32,
  tempDataReady: u32,
  rainDataReady: u32,
  tempLerp: f32,          // interpolation factor 0-1 between slot0 and slot1
  tempLoadedPoints: u32,  // progressive loading: cells 0..N are valid
  tempSlot0: u32,         // slot index for time0 in tempData buffer
  tempSlot1: u32,         // slot index for time1 in tempData buffer
  gridFontSize: f32, // font size in screen pixels for grid labels
  gridLabelMaxRadius: f32, // max globe radius (px) before labels shrink
  gridLineWidth: f32, // line width in screen pixels
  tempPaletteRange: vec2f, // min/max temperature values for palette mapping (Celsius)
  // Additional weather layer opacities
  cloudsOpacity: f32,
  humidityOpacity: f32,
  windOpacity: f32,
  cloudsDataReady: u32,
  humidityDataReady: u32,
  windDataReady: u32,
  logoOpacity: f32,       // computed from all layer opacities
  logoPad: f32,           // padding for alignment
  // User layer slots (32 max) - packed as vec4s for alignment
  userLayerOpacity: array<vec4<f32>, 8>,   // 32 opacity values
  userLayerDataReady: array<vec4<u32>, 8>, // 32 data ready flags
  // Dynamic param state (16 params max) - for per-param interpolation
  paramLerp: array<vec4<f32>, 4>,          // 16 lerp factors (0.0-1.0)
  paramReady: array<vec4<u32>, 4>,         // 16 data ready flags
}

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

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var basemap: texture_cube<f32>;
@group(0) @binding(2) var basemapSampler: sampler;
@group(0) @binding(3) var<storage, read> gaussianLats: array<f32>;
@group(0) @binding(4) var<storage, read> ringOffsets: array<u32>;
// Bindings 5-6 removed (legacy tempData0/1 - now using dynamic param bindings)
// Atmosphere LUTs (Bruneton precomputed scattering)
@group(0) @binding(7) var atm_transmittance: texture_2d<f32>;
@group(0) @binding(8) var atm_scattering: texture_3d<f32>;
@group(0) @binding(9) var atm_irradiance: texture_2d<f32>;
@group(0) @binding(10) var atm_sampler: sampler;
// Font atlas for grid labels (declared in grid-text.wgsl)
// @group(0) @binding(11) var fontAtlas: texture_2d<f32>;
// @group(0) @binding(12) var fontSampler: sampler;
// Temperature palette (1D texture for color mapping)
@group(0) @binding(13) var tempPalette: texture_2d<f32>;
@group(0) @binding(14) var tempPaletteSampler: sampler;
// Additional weather layer data (legacy - will migrate to dynamic)
@group(0) @binding(15) var<storage, read> cloudsData: array<f32>;
@group(0) @binding(16) var<storage, read> humidityData: array<f32>;
@group(0) @binding(17) var<storage, read> windData: array<f32>;
// Binding 18 removed (legacy rainData - now using dynamic param bindings)
// Logo texture for idle globe display
@group(0) @binding(19) var logoTexture: texture_2d<f32>;
@group(0) @binding(20) var logoSampler: sampler;

// {{PARAM_BINDINGS}} - Dynamic param buffer bindings (generated by ShaderComposer)

// {{PARAM_SAMPLERS}} - Dynamic param sampler functions (generated by ShaderComposer)

// Fullscreen triangle vertex shader
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  return vec4f(pos[vertexIndex], 0.0, 1.0);
}

fn computeRay(fragCoord: vec2f) -> vec3f {
  // Compute NDC (-1 to 1)
  let ndc = vec2f(
    (fragCoord.x / u.resolution.x) * 2.0 - 1.0,
    1.0 - (fragCoord.y / u.resolution.y) * 2.0
  );

  // Camera always looks at origin, so forward = -normalize(eyePosition)
  let forward = -normalize(u.eyePosition);

  // Compute right and up from forward and world up (0,1,0)
  let worldUp = vec3f(0.0, 1.0, 0.0);
  let right = normalize(cross(forward, worldUp));
  let up = cross(right, forward);

  let aspect = u.resolution.x / u.resolution.y;

  // Compute ray direction using tanFov from uniforms
  let rayDir = normalize(
    forward +
    right * ndc.x * u.tanFov * aspect +
    up * ndc.y * u.tanFov
  );

  return rayDir;
}

struct FragmentOutput {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fs_main(@builtin(position) fragPos: vec4f) -> FragmentOutput {
  let rayDir = computeRay(fragPos.xy);
  let hit = raySphereIntersect(u.eyePosition, rayDir, EARTH_RADIUS);

  if (!hit.valid) {
    // Ray misses earth - return background color (atmosphere applied in post-process)
    return FragmentOutput(BG_COLOR, 1.0);  // Far plane depth for sky
  }

  let lat = asin(hit.point.y);
  let lon = atan2(hit.point.x, hit.point.z);

  // Layer compositing (back to front)
  // Atmosphere applied in post-process pass
  var color = vec4f(0.086, 0.086, 0.086, 1.0); // Base dark color (#161616)

  // {{SURFACE_BLEND_CALLS}} - replaced by ShaderComposer

  // Animated back-side grid: fades in from limb as surface layers fade out
  // Only activates when both layers are nearly invisible (below 0.3 opacity)
  let maxOpacity = max(u.earthOpacity, u.tempOpacity);
  let fadeAmount = smoothstep(0.3, 0.0, maxOpacity);
  if (fadeAmount > 0.01) {
    let farHit = raySphereIntersectFar(u.eyePosition, rayDir, EARTH_RADIUS);
    if (farHit.valid) {
      // How close to limb: 0=center of back hemisphere, 1=at limb
      let backViewAngle = dot(normalize(farHit.point), -rayDir);
      let limbFactor = 1.0 - backViewAngle;

      // Fade in from limb inward as fadeAmount increases
      let backOpacity = smoothstep(1.0 - fadeAmount, 1.0, limbFactor);

      let backLat = asin(farHit.point.y);
      let backLon = atan2(farHit.point.x, farHit.point.z);
      let colorBeforeBack = color;
      color = blendGrid(color, backLat, backLon, farHit.point);
      color = blendGridText(color, backLat, backLon, farHit.point);
      color = mix(colorBeforeBack, color, backOpacity);
    }
  }

  // Front grid (always on top)
  color = blendGrid(color, lat, lon, hit.point);
  color = blendGridText(color, lat, lon, hit.point);

  // Logo (only visible when all layers are off)
  color = blendLogo(color, fragPos.xy);

  // Compute normalized depth from ray hit distance
  // hit.t is distance from camera to globe surface
  // Normalize against camera distance to globe (gives ~0.5-0.7 for typical views)
  let cameraDistance = length(u.eyePosition);
  var normalizedDepth = clamp(hit.t / (cameraDistance * 2.0), 0.0, 1.0);

  // Animated limb for pressure/wind: push depth toward far plane near limb as layers fade
  // Uses same fadeAmount logic as back-side grid
  let depthFadeAmount = smoothstep(0.3, 0.0, max(u.earthOpacity, u.tempOpacity));
  if (depthFadeAmount > 0.01) {
    let viewAngle = dot(normalize(hit.point), -rayDir);  // 1=facing camera, 0=at limb
    let limbFactor = 1.0 - viewAngle;  // 0=center, 1=limb
    let limbPush = smoothstep(1.0 - depthFadeAmount, 1.0, limbFactor);
    // At full fade, push entire surface; limb animates first, center follows
    let depthPush = max(limbPush, depthFadeAmount);
    normalizedDepth = mix(normalizedDepth, 0.9999, depthPush);
  }

  return FragmentOutput(color, normalizedDepth);
}
