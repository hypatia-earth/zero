// Master shader for atmosphere post-process pass
// Processed by wgsl-plus - separate from globe shader


// Uniforms struct must be declared FIRST (before files that reference `u`)
// Must match main.wgsl exactly for shared uniform buffer
struct Uniforms {
  viewProjInverse: mat4x4f,   // 64 bytes
  eyePosition: vec3f,         // 12 + 4 pad = 16 bytes
  eyePad: f32,
  resolution: vec2f,          // 8 bytes
  tanFov: f32,                // 4 bytes
  resPad: f32,                // 4 bytes pad = 16 bytes total
  time: f32,                  // 4 bytes
  sunOpacity: f32,            // 4 bytes
  sunPad: vec2f,              // 8 bytes pad
  sunDirection: vec3f,        // 12 + 4 pad = 16 bytes
  sunDirPad: f32,
  sunCoreRadius: f32,         // 4 bytes
  sunGlowRadius: f32,         // 4 bytes
  sunRadiiPad: vec2f,         // 8 bytes pad = 16 bytes
  sunCoreColor: vec3f,        // 12 + 4 pad = 16 bytes
  sunCoreColorPad: f32,
  sunGlowColor: vec3f,        // 12 + 4 pad = 16 bytes
  sunGlowColorPad: f32,
  gridEnabled: u32,
  gridOpacity: f32,
  earthOpacity: f32,
  tempOpacity: f32,
  rainOpacity: f32,
  tempDataReady: u32,
  rainDataReady: u32,
  tempLerp: f32,
  tempLoadedPoints: u32,
  tempSlot0: u32,
  tempSlot1: u32,
  gridFontSize: f32,
  tempLoadedPad: f32,
  tempPaletteRange: vec2f,
}

// Atmosphere shader module - Bruneton precomputed scattering
// Adapted from: https://github.com/jeantimex/precomputed_atmospheric_scattering

// LUT texture dimensions (must match precomputed data)
const TRANSMITTANCE_TEXTURE_WIDTH: i32 = 256;
const TRANSMITTANCE_TEXTURE_HEIGHT: i32 = 64;
const SCATTERING_TEXTURE_R_SIZE: i32 = 32;
const SCATTERING_TEXTURE_MU_SIZE: i32 = 128;
const SCATTERING_TEXTURE_MU_S_SIZE: i32 = 32;
const SCATTERING_TEXTURE_NU_SIZE: i32 = 8;
const IRRADIANCE_TEXTURE_WIDTH: i32 = 64;
const IRRADIANCE_TEXTURE_HEIGHT: i32 = 16;

// Physical constants
const ATM_PI: f32 = 3.14159265358979323846;

// Atmosphere parameters (Earth)
// bottom_radius = 6360 km, top_radius = 6420 km (60 km atmosphere)
// Zero uses unit sphere, so scale factor = 6360
const EARTH_RADIUS_KM: f32 = 6360.0;
const ATMOSPHERE_THICKNESS_KM: f32 = 60.0;
const TOP_RADIUS_KM: f32 = 6420.0;

// For zero: earth radius = 1.0, so atmosphere top = 1.0 + 60/6360 = 1.00943
const ATM_BOTTOM_RADIUS: f32 = 1.0;
const ATM_TOP_RADIUS: f32 = 1.00943;  // 1.0 + 60/6360

// Scale to convert from zero's unit sphere to km for LUT sampling
const UNIT_TO_KM: f32 = 6360.0;

// Scattering coefficients (precomputed into LUTs, but needed for phase functions)
const RAYLEIGH_SCATTERING: vec3f = vec3f(0.005802, 0.013558, 0.033100);
const MIE_SCATTERING: vec3f = vec3f(0.003996, 0.003996, 0.003996);
const MIE_PHASE_G: f32 = 0.8;
const SOLAR_IRRADIANCE: vec3f = vec3f(1.474000, 1.850400, 1.911980);
const SUN_ANGULAR_RADIUS: f32 = 0.004675;
const MU_S_MIN: f32 = -0.207912;

// Helper functions
fn ClampCosine(mu: f32) -> f32 { return clamp(mu, -1.0, 1.0); }
fn ClampDistance(d: f32) -> f32 { return max(d, 0.0); }
fn SafeSqrt(v: f32) -> f32 { return sqrt(max(v, 0.0)); }

fn ClampRadius(r: f32) -> f32 {
  return clamp(r, EARTH_RADIUS_KM, TOP_RADIUS_KM);
}

fn RayDistanceToAtmosphereTop(r: f32, mu: f32) -> f32 {
  let discriminant = r * r * (mu * mu - 1.0) + TOP_RADIUS_KM * TOP_RADIUS_KM;
  return ClampDistance(-r * mu + SafeSqrt(discriminant));
}

fn RayIntersectsGround(r: f32, mu: f32) -> bool {
  return mu < 0.0 && (r * r * (mu * mu - 1.0) + EARTH_RADIUS_KM * EARTH_RADIUS_KM >= 0.0);
}

fn NormalizedToTexCoord(x: f32, texture_size: i32) -> f32 {
  return 0.5 / f32(texture_size) + x * (1.0 - 1.0 / f32(texture_size));
}

// Transmittance LUT sampling
fn MapToTransmittanceTexture(r: f32, mu: f32) -> vec2f {
  let H = sqrt(TOP_RADIUS_KM * TOP_RADIUS_KM - EARTH_RADIUS_KM * EARTH_RADIUS_KM);
  let rho = SafeSqrt(r * r - EARTH_RADIUS_KM * EARTH_RADIUS_KM);
  let d = RayDistanceToAtmosphereTop(r, mu);
  let d_min = TOP_RADIUS_KM - r;
  let d_max = rho + H;
  let x_mu = (d - d_min) / (d_max - d_min);
  let x_r = rho / H;
  return vec2f(
    NormalizedToTexCoord(x_mu, TRANSMITTANCE_TEXTURE_WIDTH),
    NormalizedToTexCoord(x_r, TRANSMITTANCE_TEXTURE_HEIGHT)
  );
}

fn SampleTransmittanceLUT(
  transmittance_texture: texture_2d<f32>,
  lut_sampler: sampler,
  r: f32, mu: f32
) -> vec3f {
  let uv = MapToTransmittanceTexture(r, mu);
  return textureSampleLevel(transmittance_texture, lut_sampler, uv, 0.0).rgb;
}

fn GetTransmittance(
  transmittance_texture: texture_2d<f32>,
  lut_sampler: sampler,
  r: f32, mu: f32, d: f32, ray_r_mu_intersects_ground: bool
) -> vec3f {
  let r_d = ClampRadius(sqrt(d * d + 2.0 * r * mu * d + r * r));
  let mu_d = ClampCosine((r * mu + d) / r_d);

  if (ray_r_mu_intersects_ground) {
    return min(
      SampleTransmittanceLUT(transmittance_texture, lut_sampler, r_d, -mu_d) /
      SampleTransmittanceLUT(transmittance_texture, lut_sampler, r, -mu),
      vec3f(1.0));
  }
  return min(
    SampleTransmittanceLUT(transmittance_texture, lut_sampler, r, mu) /
    SampleTransmittanceLUT(transmittance_texture, lut_sampler, r_d, mu_d),
    vec3f(1.0));
}

fn GetTransmittanceToSun(
  transmittance_texture: texture_2d<f32>,
  lut_sampler: sampler,
  r: f32, mu_s: f32
) -> vec3f {
  let sin_theta_h = EARTH_RADIUS_KM / r;
  let cos_theta_h = -sqrt(max(1.0 - sin_theta_h * sin_theta_h, 0.0));
  return SampleTransmittanceLUT(transmittance_texture, lut_sampler, r, mu_s) *
    smoothstep(-sin_theta_h * SUN_ANGULAR_RADIUS, sin_theta_h * SUN_ANGULAR_RADIUS, mu_s - cos_theta_h);
}

// Phase functions
fn RayleighPhaseFunction(nu: f32) -> f32 {
  let k = 3.0 / (16.0 * ATM_PI);
  return k * (1.0 + nu * nu);
}

fn MiePhaseFunction(g: f32, nu: f32) -> f32 {
  let k = 3.0 / (8.0 * ATM_PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + nu * nu) / pow(1.0 + g * g - 2.0 * g * nu, 1.5);
}

// Scattering LUT sampling (4D packed into 3D)
fn MapToScatteringTexture(r: f32, mu: f32, mu_s: f32, nu: f32, ray_r_mu_intersects_ground: bool) -> vec4f {
  let H = sqrt(TOP_RADIUS_KM * TOP_RADIUS_KM - EARTH_RADIUS_KM * EARTH_RADIUS_KM);
  let rho = SafeSqrt(r * r - EARTH_RADIUS_KM * EARTH_RADIUS_KM);
  let u_r = NormalizedToTexCoord(rho / H, SCATTERING_TEXTURE_R_SIZE);

  let r_mu = r * mu;
  let discriminant = r_mu * r_mu - r * r + EARTH_RADIUS_KM * EARTH_RADIUS_KM;

  var u_mu: f32;
  if (ray_r_mu_intersects_ground) {
    let d = -r_mu - SafeSqrt(discriminant);
    let d_min = r - EARTH_RADIUS_KM;
    let d_max = rho;
    var ratio: f32;
    if (d_max == d_min) { ratio = 0.0; } else { ratio = (d - d_min) / (d_max - d_min); }
    u_mu = 0.5 - 0.5 * NormalizedToTexCoord(ratio, SCATTERING_TEXTURE_MU_SIZE / 2);
  } else {
    let d = -r_mu + SafeSqrt(discriminant + H * H);
    let d_min = TOP_RADIUS_KM - r;
    let d_max = rho + H;
    u_mu = 0.5 + 0.5 * NormalizedToTexCoord((d - d_min) / (d_max - d_min), SCATTERING_TEXTURE_MU_SIZE / 2);
  }

  let d = RayDistanceToAtmosphereTop(EARTH_RADIUS_KM, mu_s);
  let d_min = TOP_RADIUS_KM - EARTH_RADIUS_KM;
  let d_max = H;
  let a = (d - d_min) / (d_max - d_min);
  let D = RayDistanceToAtmosphereTop(EARTH_RADIUS_KM, MU_S_MIN);
  let A = (D - d_min) / (d_max - d_min);
  let u_mu_s = NormalizedToTexCoord(max(1.0 - a / A, 0.0) / (1.0 + a), SCATTERING_TEXTURE_MU_S_SIZE);
  let u_nu = (nu + 1.0) * 0.5;

  return vec4f(u_nu, u_mu_s, u_mu, u_r);
}

fn ExtrapolateSingleMie(scattering: vec4f) -> vec3f {
  if (scattering.x <= 0.0) { return vec3f(0.0); }
  return scattering.xyz * scattering.w / scattering.x *
    (RAYLEIGH_SCATTERING.x / MIE_SCATTERING.x) *
    (MIE_SCATTERING / RAYLEIGH_SCATTERING);
}

struct CombinedScatteringResult {
  scattering: vec3f,
  single_mie: vec3f,
}

fn GetCombinedScattering(
  scattering_texture: texture_3d<f32>,
  lut_sampler: sampler,
  r: f32, mu: f32, mu_s: f32, nu: f32, ray_r_mu_intersects_ground: bool
) -> CombinedScatteringResult {
  let uvwz = MapToScatteringTexture(r, mu, mu_s, nu, ray_r_mu_intersects_ground);
  let tex_coord_x = uvwz.x * f32(SCATTERING_TEXTURE_NU_SIZE - 1);
  let tex_x = floor(tex_coord_x);
  let lerp = tex_coord_x - tex_x;

  let uvw0 = vec3f((tex_x + uvwz.y) / f32(SCATTERING_TEXTURE_NU_SIZE), uvwz.z, uvwz.w);
  let uvw1 = vec3f((tex_x + 1.0 + uvwz.y) / f32(SCATTERING_TEXTURE_NU_SIZE), uvwz.z, uvwz.w);
  let combined0 = textureSampleLevel(scattering_texture, lut_sampler, uvw0, 0.0);
  let combined1 = textureSampleLevel(scattering_texture, lut_sampler, uvw1, 0.0);
  let combined = combined0 * (1.0 - lerp) + combined1 * lerp;

  var result: CombinedScatteringResult;
  result.scattering = combined.rgb;
  result.single_mie = ExtrapolateSingleMie(combined);
  return result;
}

// Main sky radiance function
struct SkySample {
  radiance: vec3f,
  transmittance: vec3f,
}

fn GetSkyRadiance(
  transmittance_texture: texture_2d<f32>,
  scattering_texture: texture_3d<f32>,
  lut_sampler: sampler,
  camera_km: vec3f,
  view_ray: vec3f,
  sun_direction: vec3f
) -> SkySample {
  var local_camera = camera_km;
  var r = length(local_camera);
  var rmu = dot(local_camera, view_ray);

  // Handle camera outside atmosphere
  let distance_to_top = -rmu - sqrt(max(0.0, rmu * rmu - r * r + TOP_RADIUS_KM * TOP_RADIUS_KM));
  if (distance_to_top > 0.0) {
    local_camera = local_camera + view_ray * distance_to_top;
    r = TOP_RADIUS_KM;
    rmu += distance_to_top;
  } else if (r > TOP_RADIUS_KM) {
    // Ray misses atmosphere entirely - return black space
    return SkySample(vec3f(0.0), vec3f(1.0));
  }

  let mu = rmu / r;
  let mu_s = dot(local_camera, sun_direction) / r;
  let nu = dot(view_ray, sun_direction);
  let ray_r_mu_intersects_ground = RayIntersectsGround(r, mu);

  var transmittance: vec3f;
  if (ray_r_mu_intersects_ground) {
    transmittance = vec3f(0.0);
  } else {
    transmittance = SampleTransmittanceLUT(transmittance_texture, lut_sampler, r, mu);
  }

  let scatter_result = GetCombinedScattering(
    scattering_texture, lut_sampler, r, mu, mu_s, nu, ray_r_mu_intersects_ground);

  let radiance = scatter_result.scattering * RayleighPhaseFunction(nu) +
    scatter_result.single_mie * MiePhaseFunction(MIE_PHASE_G, nu);

  return SkySample(radiance, transmittance);
}

// Aerial perspective - scattering along ray to a point
fn GetSkyRadianceToPoint(
  transmittance_texture: texture_2d<f32>,
  scattering_texture: texture_3d<f32>,
  lut_sampler: sampler,
  camera_km: vec3f,
  point_km: vec3f,
  sun_direction: vec3f
) -> SkySample {
  let view_ray = normalize(point_km - camera_km);
  var local_camera = camera_km;
  var r = length(local_camera);
  var rmu = dot(local_camera, view_ray);

  let distance_to_top = -rmu - sqrt(max(0.0, rmu * rmu - r * r + TOP_RADIUS_KM * TOP_RADIUS_KM));
  if (distance_to_top > 0.0) {
    local_camera = local_camera + view_ray * distance_to_top;
    r = TOP_RADIUS_KM;
    rmu += distance_to_top;
  }

  let mu = rmu / r;
  let mu_s = dot(local_camera, sun_direction) / r;
  let nu = dot(view_ray, sun_direction);
  let d = length(point_km - local_camera);
  let ray_r_mu_intersects_ground = RayIntersectsGround(r, mu);

  let transmittance = GetTransmittance(transmittance_texture, lut_sampler, r, mu, d, ray_r_mu_intersects_ground);

  var scatter_result = GetCombinedScattering(
    scattering_texture, lut_sampler, r, mu, mu_s, nu, ray_r_mu_intersects_ground);

  let r_p = ClampRadius(sqrt(d * d + 2.0 * r * mu * d + r * r));
  let mu_p = (r * mu + d) / r_p;
  let mu_s_p = (r * mu_s + d * nu) / r_p;

  let scatter_p = GetCombinedScattering(
    scattering_texture, lut_sampler, r_p, mu_p, mu_s_p, nu, ray_r_mu_intersects_ground);

  scatter_result.scattering -= transmittance * scatter_p.scattering;
  scatter_result.single_mie -= transmittance * scatter_p.single_mie;
  scatter_result.single_mie *= smoothstep(0.0, 0.01, mu_s);

  let radiance = scatter_result.scattering * RayleighPhaseFunction(nu) +
    scatter_result.single_mie * MiePhaseFunction(MIE_PHASE_G, nu);

  return SkySample(radiance, transmittance);
}

// Get solar radiance (for sun disk)
fn GetSolarRadiance() -> vec3f {
  return SOLAR_IRRADIANCE / (ATM_PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS);
}

// Spectral radiance to luminance conversion
const SKY_SPECTRAL_RADIANCE_TO_LUMINANCE: vec3f = vec3f(114974.916437, 71305.954816, 65310.548555);
const SUN_SPECTRAL_RADIANCE_TO_LUMINANCE: vec3f = vec3f(98242.786222, 69954.398112, 66475.012354);

// Common constants and types shared across all shader modules

const COMMON_PI: f32 = 3.14159265359;
const COMMON_TAU: f32 = 6.28318530718;
const EARTH_RADIUS: f32 = 1.0;
const BG_COLOR: vec4f = vec4f(0.086, 0.086, 0.086, 1.0);

struct RayHit {
  valid: bool,
  point: vec3f,
  t: f32,
}

fn raySphereIntersect(rayOrigin: vec3f, rayDir: vec3f, radius: f32) -> RayHit {
  let oc = rayOrigin;
  let a = dot(rayDir, rayDir);
  let b = 2.0 * dot(oc, rayDir);
  let c = dot(oc, oc) - radius * radius;
  let discriminant = b * b - 4.0 * a * c;

  if (discriminant < 0.0) {
    return RayHit(false, vec3f(0.0), 0.0);
  }

  let t = (-b - sqrt(discriminant)) / (2.0 * a);
  if (t < 0.0) {
    return RayHit(false, vec3f(0.0), 0.0);
  }

  let point = rayOrigin + t * rayDir;
  return RayHit(true, point, t);
}

// Far intersection (back of sphere) - for rendering back-side grid
fn raySphereIntersectFar(rayOrigin: vec3f, rayDir: vec3f, radius: f32) -> RayHit {
  let oc = rayOrigin;
  let a = dot(rayDir, rayDir);
  let b = 2.0 * dot(oc, rayDir);
  let c = dot(oc, oc) - radius * radius;
  let discriminant = b * b - 4.0 * a * c;

  if (discriminant < 0.0) {
    return RayHit(false, vec3f(0.0), 0.0);
  }

  let t = (-b + sqrt(discriminant)) / (2.0 * a);  // + for far hit
  if (t < 0.0) {
    return RayHit(false, vec3f(0.0), 0.0);
  }

  let point = rayOrigin + t * rayDir;
  return RayHit(true, point, t);
}

// Sun layer - sun disc and glow rendering

fn blendSun(color: vec4f, fragCoord: vec2f) -> vec4f {
  if (u.sunOpacity < 0.01) { return color; }

  // Project sun direction to screen space
  let aspect = u.resolution.x / u.resolution.y;
  let forward = -normalize(u.eyePosition);
  let worldUp = vec3f(0.0, 1.0, 0.0);
  let right = normalize(cross(forward, worldUp));
  let up = cross(right, forward);

  // Sun direction relative to camera
  let sunLocal = vec3f(
    dot(u.sunDirection, right),
    dot(u.sunDirection, up),
    dot(u.sunDirection, forward)
  );

  // Only render if sun is in front of camera
  if (sunLocal.z <= 0.0) { return color; }

  // Project to screen coords (normalized, no aspect correction yet)
  let sunScreen = vec2f(
    sunLocal.x / (sunLocal.z * u.tanFov),
    sunLocal.y / (sunLocal.z * u.tanFov)
  );

  // Current pixel in NDC
  let pixelNDC = vec2f(
    (fragCoord.x / u.resolution.x) * 2.0 - 1.0,
    1.0 - (fragCoord.y / u.resolution.y) * 2.0
  );

  // Compute difference, then correct X for aspect ratio
  let diff = vec2f(
    (pixelNDC.x - sunScreen.x) * aspect,
    pixelNDC.y - sunScreen.y
  );

  // Distance in screen space (perfect circle)
  let dist = length(diff);

  // Core disc
  if (dist < u.sunCoreRadius) {
    return vec4f(mix(color.rgb, u.sunCoreColor, u.sunOpacity), 1.0);
  }

  // Glow falloff - directly outside core
  if (dist < u.sunGlowRadius) {
    let t = 1.0 - (dist - u.sunCoreRadius) / (u.sunGlowRadius - u.sunCoreRadius);
    let glow = u.sunGlowColor * t * t * 0.4 * u.sunOpacity;
    return vec4f(color.rgb + glow, 1.0);
  }

  return color;
}

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

// Atmosphere Post-Process Shader
// Applies atmospheric effects to the rendered scene based on depth
//
// Reads: color texture (scene without atmosphere), depth texture
// Outputs: final color with atmosphere applied to all geometry

// Uniforms struct 'u' is declared in master-postprocess.wgsl before includes
// Bindings for post-process pass
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var sceneColor: texture_2d<f32>;
@group(0) @binding(2) var sceneDepth: texture_depth_2d;
@group(0) @binding(3) var sceneSampler: sampler;
// Atmosphere LUTs
@group(0) @binding(4) var atm_transmittance: texture_2d<f32>;
@group(0) @binding(5) var atm_scattering: texture_3d<f32>;
@group(0) @binding(6) var atm_irradiance: texture_2d<f32>;
@group(0) @binding(7) var atm_sampler: sampler;

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