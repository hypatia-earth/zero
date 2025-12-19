// Atmosphere blend functions - simplified approach without LUT for globe surface
// Uses Bruneton LUT only for sky/space, simple math for globe

// Atmosphere tuning params
const ATM_EXPOSURE: f32 = 5.0;            // Tone mapping exposure (higher = brighter)
const ATM_NIGHT_BRIGHTNESS: f32 = 0.15;   // Night side darkness (0 = black, 1 = same as day)

// Tone mapping (Reinhard with exposure)
fn toneMap(radiance: vec3f, exposure: f32) -> vec3f {
  let white_point = vec3f(1.0, 1.0, 1.0);
  return pow(vec3f(1.0) - exp(-radiance / white_point * exposure), vec3f(1.0 / 2.2));
}

fn blendAtmosphereSpace(color: vec4f, rayDir: vec3f, camera_km: vec3f, exposure: f32, fragPos: vec4f) -> vec4f {
  if (u.sunOpacity < 0.01) { return color; }

  // Compute atmospheric scattering for sky/space (uses Bruneton LUT)
  let sky = GetSkyRadiance(
    atm_transmittance, atm_scattering, atm_sampler,
    camera_km, rayDir, u.sunDirection
  );

  // Blend atmosphere over background color (not pure black space)
  let atm_color = toneMap(sky.radiance, exposure) * u.sunOpacity;
  var sky_color = vec4f(color.rgb + atm_color, 1.0);

  // Add sun disc/glow
  sky_color = blendSun(sky_color, fragPos.xy);

  return sky_color;
}

fn blendAtmosphereGlobe(color: vec4f, hitPoint: vec3f, camera_km: vec3f, exposure: f32) -> vec4f {
  if (u.sunOpacity < 0.01) { return color; }

  // View angle: edgeFactor = 0 at center, 1 at limb
  let viewDir = normalize(u.eyePosition - hitPoint);
  let surfaceNormal = normalize(hitPoint);
  let viewDot = max(dot(viewDir, surfaceNormal), 0.0);
  let edgeFactor = 1.0 - viewDot;

  // Day/night factor
  let sunDot = dot(surfaceNormal, u.sunDirection);
  let dayFactor = smoothstep(-0.1, 0.1, sunDot);
  let dayNight = mix(ATM_NIGHT_BRIGHTNESS, 1.0, dayFactor);

  // Terminator band: narrow band right at dawn/dusk, day side only
  // sunDot: -1 = midnight, 0 = terminator, +1 = noon
  let terminatorFactor = smoothstep(-0.05, 0.05, sunDot) * smoothstep(0.2, 0.0, sunDot);
  let terminatorBand = terminatorFactor;

  // Simple approach: darken surface for day/night (blend with sunOpacity)
  let dayNightBlend = mix(1.0, dayNight, u.sunOpacity);
  let dimmedSurface = color.rgb * dayNightBlend;

  // Blue limb glow - only at edges, stronger on day side
  let blueGlow = vec3f(0.4, 0.6, 1.0) * pow(edgeFactor, 2.0) * dayFactor * 0.5 * u.sunOpacity;

  // Warm terminator glow - orange/gold near sunrise/sunset
  let warmColor = vec3f(1.0, 0.6, 0.3);  // sunset orange
  let warmGlow = warmColor * terminatorBand * 0.15 * u.sunOpacity;

  let final_color = dimmedSurface + blueGlow + warmGlow;

  return vec4f(final_color, 1.0);
}
