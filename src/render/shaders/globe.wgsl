// Globe shader - orchestrator that composes all layers
// Modules are concatenated before this file:
//   atmosphere.wgsl -> common.wgsl -> temperature.wgsl -> rain.wgsl ->
//   basemap.wgsl -> sun.wgsl -> grid.wgsl -> atmosphere-blend.wgsl -> globe.wgsl

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
  tempLoadedPad: f32,     // padding to 16-byte alignment
  tempPaletteRange: vec2f, // min/max temperature values for palette mapping (Celsius)
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var basemap: texture_cube<f32>;
@group(0) @binding(2) var basemapSampler: sampler;
@group(0) @binding(3) var<storage, read> gaussianLats: array<f32>;
@group(0) @binding(4) var<storage, read> ringOffsets: array<u32>;
@group(0) @binding(5) var<storage, read> tempData: array<f32>;
@group(0) @binding(6) var<storage, read> rainData: array<f32>;
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
  var color = vec4f(0.1, 0.1, 0.15, 1.0); // Base dark color
  color = blendBasemap(color, hit.point);
  color = blendTemp(color, lat, lon);
  color = blendRain(color, lat, lon);
  color = blendGrid(color, lat, lon, hit.point);
  color = blendGridText(color, lat, lon, hit.point);

  // Compute normalized depth from ray hit distance
  // hit.t is distance from camera to globe surface
  // Normalize against camera distance to globe (gives ~0.5-0.7 for typical views)
  let cameraDistance = length(u.eyePosition);
  let normalizedDepth = clamp(hit.t / (cameraDistance * 2.0), 0.0, 1.0);

  return FragmentOutput(color, normalizedDepth);
}
