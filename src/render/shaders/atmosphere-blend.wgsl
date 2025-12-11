// Atmosphere blend functions - uses atmosphere.wgsl LUT functions

// Atmosphere tuning params
const ATM_EXPOSURE: f32 = 4.0;            // Tone mapping exposure (higher = brighter)
const ATM_MIE_REDUCTION: f32 = 0.3;       // Reduce white haze (0 = none, 1 = full Bruneton)
const ATM_NIGHT_BRIGHTNESS: f32 = 0.15;   // Night side darkness (0 = black, 1 = same as day)
const ATM_SURFACE_RADIANCE: f32 = 0.1;    // Earth brightness vs atmosphere (higher = earth shows more)

// Tone mapping (Reinhard with exposure)
fn toneMap(radiance: vec3f, exposure: f32) -> vec3f {
  let white_point = vec3f(1.0, 1.0, 1.0);
  return pow(vec3f(1.0) - exp(-radiance / white_point * exposure), vec3f(1.0 / 2.2));
}

fn blendAtmosphereSpace(color: vec4f, rayDir: vec3f, camera_km: vec3f, exposure: f32, fragPos: vec4f) -> vec4f {
  if (u.sunEnabled == 0u) { return color; }

  // Compute atmospheric scattering for sky/space
  let sky = GetSkyRadiance(
    atm_transmittance, atm_scattering, atm_sampler,
    camera_km, rayDir, u.sunDirection
  );

  // Blend atmosphere over background color (not pure black space)
  let atm_color = toneMap(sky.radiance, exposure);
  var sky_color = vec4f(color.rgb + atm_color, 1.0);

  // Add sun disc/glow
  sky_color = blendSun(sky_color, fragPos.xy);

  return sky_color;
}

fn blendAtmosphereGlobe(color: vec4f, hitPoint: vec3f, camera_km: vec3f, exposure: f32) -> vec4f {
  if (u.sunEnabled == 0u) { return color; }

  // Aerial perspective (atmospheric haze) for earth surface
  let point_km = hitPoint * UNIT_TO_KM;
  let aerial = GetSkyRadianceToPoint(
    atm_transmittance, atm_scattering, atm_sampler,
    camera_km, point_km, u.sunDirection
  );

  // Reduce Mie (white haze) while keeping Rayleigh (blue tint)
  let reduced_radiance = aerial.radiance * ATM_MIE_REDUCTION;

  // Day/night factor for surface brightness
  let sunDot = dot(normalize(hitPoint), u.sunDirection);
  let dayFactor = smoothstep(-0.1, 0.1, sunDot);
  let dayNight = mix(ATM_NIGHT_BRIGHTNESS, 1.0, dayFactor);

  // Blend atmosphere over earth: surface * transmittance + scattered light
  let surface_radiance = color.rgb * ATM_SURFACE_RADIANCE * dayNight;
  let final_radiance = surface_radiance * aerial.transmittance + reduced_radiance;
  let final_color = toneMap(final_radiance, exposure);

  return vec4f(final_color, 1.0);
}
