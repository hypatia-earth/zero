// Atmosphere Post-Process Shader
// Applies atmospheric effects to the rendered scene based on depth
//
// Reads: color texture (scene without atmosphere), depth texture
// Outputs: final color with atmosphere applied to all geometry

import package::aurora::shaders::layer_helpers::u;
import package::layers::sun::atmo::UNIT_TO_KM;
import package::layers::sun::blend::{blendAtmosphereSpace, blendAtmosphereGlobe, ATM_EXPOSURE};

// Bindings for post-process pass (binding(0) = uniforms from layer-helpers)
@group(0) @binding(1) var sceneColor: texture_2d<f32>;
@group(0) @binding(2) var sceneDepth: texture_depth_2d;
@group(0) @binding(3) var sceneSampler: sampler;
// Atmosphere LUT bindings (4-7) are declared in sun/blend.wesl

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

// Reconstruct world position from screen coords and linear depth
// Globe shader stores: depth = hit.t / (cameraDistance * 2.0)
// So we reverse: hit.t = depth * cameraDistance * 2.0
// Then: worldPos = eyePosition + rayDir * hit.t
fn reconstructWorldPosition(screenPos: vec2f, linearDepth: f32) -> vec3f {
  let rayDir = computeRayPP(screenPos);
  let cameraDistance = length(u.eyePosition);
  let hitT = linearDepth * cameraDistance * 2.0;
  return u.eyePosition + rayDir * hitT;
}

// Compute ray direction for given screen position
fn computeRayPP(fragCoord: vec2f) -> vec3f {
  let ndc = vec2f(
    (fragCoord.x / u.resolution.x) * 2.0 - 1.0,
    1.0 - (fragCoord.y / u.resolution.y) * 2.0
  );

  let forward = -normalize(u.eyePosition);
  let worldUp = vec3f(0.0, 1.0, 0.0);
  let right = normalize(cross(forward, worldUp));
  let up = cross(right, forward);
  let aspect = u.resolution.x / u.resolution.y;

  return normalize(
    forward +
    right * ndc.x * u.tanFov * aspect +
    up * ndc.y * u.tanFov
  );
}

// Check if depth is at far plane (sky/space)
fn isSkyPixel(depth: f32) -> bool {
  return depth > 0.9999;
}

@fragment
fn fs_main(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let screenPos = fragPos.xy;
  let uv = screenPos / u.resolution;

  // Sample scene color (use sampler for filtering)
  let color = textureSample(sceneColor, sceneSampler, uv);

  // Load depth directly (depth textures can't use samplers in WebGPU)
  let texCoord = vec2<i32>(fragPos.xy);
  let depth = textureLoad(sceneDepth, texCoord, 0);

  // Convert camera to km scale for atmosphere functions
  let camera_km = u.eyePosition * UNIT_TO_KM;

  if (isSkyPixel(depth)) {
    // Sky/space pixel - apply full sky atmosphere
    let rayDir = computeRayPP(screenPos);
    return blendAtmosphereSpace(color, rayDir, camera_km, ATM_EXPOSURE, fragPos);
  }

  // Globe or geometry pixel - apply globe atmosphere
  // Reconstruct world position from depth
  let worldPos = reconstructWorldPosition(screenPos, depth);

  // For globe surface, the world position should be near unit sphere
  // Normalize to get surface normal (works for sphere geometry)
  let hitPoint = normalize(worldPos);

  return blendAtmosphereGlobe(color, hitPoint, camera_km, ATM_EXPOSURE);
}
