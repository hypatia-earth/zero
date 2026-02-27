// Globe shader — main surface pass entry module
// Composed by ShaderComposer via WESL link()

import package::aurora::shaders::layer_helpers::{u, getLayerOpacity, getUserLayerOpacity};
import package::aurora::shaders::common::{EARTH_RADIUS, BG_COLOR, raySphereIntersect, raySphereIntersectFar};
import package::aurora::shaders::logo::blendLogo;
import package::layers::graticule::graticule::blendGraticule;
import package::layers::graticule::text::blendGraticuleText;

import package::layers::earth::base::blendBasemap;
import package::layers::temp::temp::blendTemp;
import package::layers::rain::rain::blendRain;
import package::layers::sun::sun::blendSun;
import user_layer_0::blend as blendUser0;
import user_layer_1::blend as blendUser1;
import user_layer_2::blend as blendUser2;
import user_layer_3::blend as blendUser3;
import user_layer_4::blend as blendUser4;
import user_layer_5::blend as blendUser5;
import user_layer_6::blend as blendUser6;
import user_layer_7::blend as blendUser7;
import user_layer_preview::blend as blendPreview;

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

  // User layer blend calls (slots 0-7 + preview)
  @if(USER_LAYER_0_ENABLED)
  { if (getUserLayerOpacity(0u) > 0.0) { color = blendUser0(color, lat, lon); } }
  @if(USER_LAYER_1_ENABLED)
  { if (getUserLayerOpacity(1u) > 0.0) { color = blendUser1(color, lat, lon); } }
  @if(USER_LAYER_2_ENABLED)
  { if (getUserLayerOpacity(2u) > 0.0) { color = blendUser2(color, lat, lon); } }
  @if(USER_LAYER_3_ENABLED)
  { if (getUserLayerOpacity(3u) > 0.0) { color = blendUser3(color, lat, lon); } }
  @if(USER_LAYER_4_ENABLED)
  { if (getUserLayerOpacity(4u) > 0.0) { color = blendUser4(color, lat, lon); } }
  @if(USER_LAYER_5_ENABLED)
  { if (getUserLayerOpacity(5u) > 0.0) { color = blendUser5(color, lat, lon); } }
  @if(USER_LAYER_6_ENABLED)
  { if (getUserLayerOpacity(6u) > 0.0) { color = blendUser6(color, lat, lon); } }
  @if(USER_LAYER_7_ENABLED)
  { if (getUserLayerOpacity(7u) > 0.0) { color = blendUser7(color, lat, lon); } }
  @if(USER_LAYER_PREVIEW_ENABLED)
  { if (getUserLayerOpacity(8u) > 0.0) { color = blendPreview(color, lat, lon); } }

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
