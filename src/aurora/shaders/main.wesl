// Globe shader — main surface pass entry module
// Composed by ShaderComposer via WESL link()

import package::aurora::shaders::layer_helpers::{u, getLayerOpacity};
import package::aurora::shaders::common::{EARTH_RADIUS, BG_COLOR, raySphereIntersect, raySphereIntersectFar};
import package::aurora::shaders::logo::blendLogo;
import package::layers::graticule::graticule::blendGraticule;
import package::layers::graticule::text::blendGraticuleText;

// Conditional layer imports
@if(LAYER_EARTH_ENABLED)
import package::layers::earth::base::blendBasemap;

@if(LAYER_TEMP_ENABLED)
import package::layers::temp::temp::blendTemp;

@if(LAYER_RAIN_ENABLED)
import package::layers::rain::rain::blendRain;

@if(LAYER_SUN_ENABLED)
import package::layers::sun::sun::blendSun;

import constants::{LAYER_EARTH, LAYER_TEMP, LAYER_RAIN, LAYER_SUN, LAYER_GRATICULE};

// Atmosphere LUTs (bindings 7-10, used only in post pass but declared here for layout)
@group(0) @binding(7) var atm_transmittance: texture_2d<f32>;
@group(0) @binding(8) var atm_scattering: texture_3d<f32>;
@group(0) @binding(9) var atm_irradiance: texture_2d<f32>;
@group(0) @binding(10) var atm_sampler: sampler;

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
  let ndc = vec2f(
    (fragCoord.x / u.resolution.x) * 2.0 - 1.0,
    1.0 - (fragCoord.y / u.resolution.y) * 2.0
  );

  let forward = -normalize(u.eyePosition);
  let worldUp = vec3f(0.0, 1.0, 0.0);
  let right = normalize(cross(forward, worldUp));
  let up = cross(right, forward);
  let aspect = u.resolution.x / u.resolution.y;

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
    return FragmentOutput(BG_COLOR, 1.0);
  }

  let lat = asin(hit.point.y);
  let lon = atan2(hit.point.x, hit.point.z);

  // Layer compositing (back to front)
  var color = vec4f(0.086, 0.086, 0.086, 1.0);

  // Surface blend calls (conditionally compiled)
  @if(LAYER_EARTH_ENABLED)
  { color = blendBasemap(color, hit.point); }

  @if(LAYER_TEMP_ENABLED)
  { if (getLayerOpacity(LAYER_TEMP) > 0.0) { color = blendTemp(color, lat, lon); } }

  @if(LAYER_RAIN_ENABLED)
  { if (getLayerOpacity(LAYER_RAIN) > 0.0) { color = blendRain(color, lat, lon); } }

  @if(LAYER_SUN_ENABLED)
  { if (getLayerOpacity(LAYER_SUN) > 0.0) { color = blendSun(color, fragPos.xy); } }

  // Back-side rain (when no opaque surface layers are enabled)
  @if(LAYER_RAIN_ENABLED)
  {
    if (u.rainBackFace > 0.0 && getLayerOpacity(LAYER_RAIN) > 0.0) {
      let rainFarHit = raySphereIntersectFar(u.eyePosition, rayDir, EARTH_RADIUS);
      if (rainFarHit.valid) {
        let backLat = asin(rainFarHit.point.y);
        let backLon = atan2(rainFarHit.point.x, rainFarHit.point.z);
        color = blendRain(color, backLat, backLon);
      }
    }
  }

  // Animated back-side grid: fades in from limb as surface layers fade out
  let maxOpacity = max(getLayerOpacity(LAYER_EARTH), getLayerOpacity(LAYER_TEMP));
  let fadeAmount = smoothstep(0.3, 0.0, maxOpacity);
  if (fadeAmount > 0.01) {
    let farHit = raySphereIntersectFar(u.eyePosition, rayDir, EARTH_RADIUS);
    if (farHit.valid) {
      let backViewAngle = dot(normalize(farHit.point), -rayDir);
      let limbFactor = 1.0 - backViewAngle;
      let backOpacity = smoothstep(1.0 - fadeAmount, 1.0, limbFactor);
      let backLat = asin(farHit.point.y);
      let backLon = atan2(farHit.point.x, farHit.point.z);
      let colorBeforeBack = color;
      color = blendGraticule(color, backLat, backLon, farHit.point);
      color = blendGraticuleText(color, backLat, backLon, farHit.point);
      color = mix(colorBeforeBack, color, backOpacity);
    }
  }

  // Front graticule (always on top)
  color = blendGraticule(color, lat, lon, hit.point);
  color = blendGraticuleText(color, lat, lon, hit.point);

  // Logo (only visible when all layers are off)
  color = blendLogo(color, fragPos.xy);

  // Depth
  let cameraDistance = length(u.eyePosition);
  var normalizedDepth = clamp(hit.t / (cameraDistance * 2.0), 0.0, 1.0);

  let depthFadeAmount = smoothstep(0.3, 0.0, max(max(getLayerOpacity(LAYER_EARTH), getLayerOpacity(LAYER_TEMP)), getLayerOpacity(LAYER_SUN)));
  if (depthFadeAmount > 0.01) {
    let viewAngle = dot(normalize(hit.point), -rayDir);
    let limbFactor = 1.0 - viewAngle;
    let limbPush = smoothstep(1.0 - depthFadeAmount, 1.0, limbFactor);
    let depthPush = max(limbPush, depthFadeAmount);
    normalizedDepth = mix(normalizedDepth, 0.9999, depthPush);
  }

  return FragmentOutput(color, normalizedDepth);
}
