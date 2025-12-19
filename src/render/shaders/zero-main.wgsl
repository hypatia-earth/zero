// Master shader - processed by wgsl-plus
// Includes all shader modules in dependency order

// Preserve entry points during obfuscation

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

// Logo layer - displays Hypatia logo as screen-space sprite when all layers are off

fn blendLogo(color: vec4f, fragPos: vec2f) -> vec4f {
  // Calculate total layer opacity to determine logo visibility
  let totalOpacity = u.earthOpacity + u.tempOpacity + u.rainOpacity + u.gridOpacity;

  // Logo fades out as layers fade in
  let logoOpacity = 1.0 - clamp(totalOpacity * 2.0, 0.0, 1.0);
  if (logoOpacity < 0.01) {
    return color;
  }

  // Screen-space UV (0,0 at top-left, 1,1 at bottom-right)
  let screenUV = fragPos / u.resolution;

  // Center the logo, scale to ~30% of screen height
  let aspect = u.resolution.x / u.resolution.y;
  let logoSize = 0.3;  // 30% of screen height

  // Adjust for aspect ratio (logo is square)
  let centeredUV = vec2f(
    (screenUV.x - 0.5) * aspect / logoSize + 0.5,
    (screenUV.y - 0.5) / logoSize + 0.5
  );

  // Only sample if within logo bounds
  if (centeredUV.x < 0.0 || centeredUV.x > 1.0 || centeredUV.y < 0.0 || centeredUV.y > 1.0) {
    return color;
  }

  let logoColor = textureSampleLevel(logoTexture, logoSampler, centeredUV, 0.0);

  // Blend based on luminosity (logo is white/gray on black background)
  let luminosity = logoColor.r;  // grayscale, so r=g=b
  let blendAlpha = luminosity * logoOpacity;
  return vec4f(mix(color.rgb, vec3f(1.0), blendAlpha), 1.0);
}

// Temperature layer - weather data visualization
// Uses two separate buffers (tempData0, tempData1) for interpolation
// Buffers are rebound when active slots change (no offset math needed)

// Binary search for Gaussian latitude ring
fn tempFindRing(lat: f32) -> u32 {
  var lo: u32 = 0u;
  var hi: u32 = 2559u;
  while (lo < hi) {
    let mid = (lo + hi) / 2u;
    if (gaussianLats[mid] > lat) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  return lo;
}

fn tempLatLonToCell(lat: f32, lon: f32) -> u32 {
  let ring = tempFindRing(lat);
  let ringFromPole = select(ring + 1u, 2560u - ring, ring >= 1280u);
  let nPoints = 4u * ringFromPole + 16u;
  var lonNorm = lon;
  if (lonNorm < 0.0) { lonNorm += COMMON_TAU; }
  let lonIdx = u32(floor(lonNorm / COMMON_TAU * f32(nPoints))) % nPoints;
  return ringOffsets[ring] + lonIdx;
}

// Texture-based colormap using 1D palette
fn colormapTemp(tempC: f32) -> vec3f {
  let t = clamp(
    (tempC - u.tempPaletteRange.x) / (u.tempPaletteRange.y - u.tempPaletteRange.x),
    0.0, 1.0
  );
  // Use textureSampleLevel to avoid non-uniform control flow issues
  return textureSampleLevel(tempPalette, tempPaletteSampler, vec2f(t, 0.5), 0.0).rgb;
}

// ESRI "Meaningful Temperature Palette" - designed for intuitive weather mapping
// Source: https://www.esri.com/arcgis-blog/products/arcgis-pro/mapping/a-meaningful-temperature-palette
// Key: discrete 5°F bands, dark navy at freezing, yellows comfortable, reds danger
// NO gradient mixing - each band is a solid color for clear visual distinction
fn colormapTempESRI(tempC: f32) -> vec3f {
  // Convert Celsius to Fahrenheit for palette lookup (5°F bands)
  let tempF = tempC * 1.8 + 32.0;

  // Extreme cold (< -60°F)
  if (tempF < -60.0) { return vec3f(0.82, 0.86, 0.88); }
  if (tempF < -55.0) { return vec3f(0.80, 0.84, 0.86); }
  if (tempF < -50.0) { return vec3f(0.78, 0.82, 0.85); }
  if (tempF < -45.0) { return vec3f(0.75, 0.80, 0.83); }
  if (tempF < -40.0) { return vec3f(0.72, 0.78, 0.82); }
  // Very cold gray-blues
  if (tempF < -35.0) { return vec3f(0.68, 0.75, 0.80); }
  if (tempF < -30.0) { return vec3f(0.64, 0.72, 0.78); }
  if (tempF < -25.0) { return vec3f(0.60, 0.69, 0.75); }
  if (tempF < -20.0) { return vec3f(0.56, 0.66, 0.72); }
  if (tempF < -15.0) { return vec3f(0.52, 0.63, 0.70); }
  if (tempF < -10.0) { return vec3f(0.48, 0.60, 0.68); }
  if (tempF <  -5.0) { return vec3f(0.44, 0.56, 0.65); }
  if (tempF <   0.0) { return vec3f(0.40, 0.52, 0.62); }
  // Cold blues
  if (tempF <   5.0) { return vec3f(0.36, 0.48, 0.60); }
  if (tempF <  10.0) { return vec3f(0.32, 0.44, 0.58); }
  if (tempF <  15.0) { return vec3f(0.28, 0.40, 0.55); }
  if (tempF <  20.0) { return vec3f(0.24, 0.36, 0.52); }
  if (tempF <  25.0) { return vec3f(0.20, 0.32, 0.48); }
  if (tempF <  30.0) { return vec3f(0.16, 0.26, 0.42); }
  // FREEZING WALL - dark navy (30-35°F / ~0°C)
  if (tempF <  35.0) { return vec3f(0.125, 0.19, 0.34); }
  // Cool navy to teal
  if (tempF <  40.0) { return vec3f(0.16, 0.30, 0.45); }
  if (tempF <  45.0) { return vec3f(0.20, 0.38, 0.52); }
  if (tempF <  50.0) { return vec3f(0.24, 0.46, 0.58); }
  // TURQUOISE BRIDGE (50-55°F)
  if (tempF <  55.0) { return vec3f(0.30, 0.52, 0.58); }
  if (tempF <  60.0) { return vec3f(0.38, 0.55, 0.52); }
  // Transitional teal-green (MINIMAL GREEN)
  if (tempF <  65.0) { return vec3f(0.45, 0.58, 0.48); }
  if (tempF <  70.0) { return vec3f(0.52, 0.60, 0.42); }
  // Comfortable yellows (70-85°F)
  if (tempF <  75.0) { return vec3f(0.62, 0.62, 0.36); }
  if (tempF <  80.0) { return vec3f(0.72, 0.60, 0.32); }
  if (tempF <  85.0) { return vec3f(0.78, 0.55, 0.28); }
  // Warming orange-golds (85-100°F)
  if (tempF <  90.0) { return vec3f(0.82, 0.48, 0.24); }
  if (tempF <  95.0) { return vec3f(0.84, 0.40, 0.22); }
  if (tempF < 100.0) { return vec3f(0.85, 0.33, 0.22); }
  // DANGER ZONE - pinks/reds (100°F+)
  if (tempF < 105.0) { return vec3f(0.85, 0.28, 0.35); }
  if (tempF < 110.0) { return vec3f(0.78, 0.22, 0.32); }
  if (tempF < 115.0) { return vec3f(0.68, 0.16, 0.28); }
  if (tempF < 120.0) { return vec3f(0.58, 0.13, 0.24); }
  // Extreme heat - dark maroon
  return vec3f(0.42, 0.11, 0.17);
}

fn blendTemp(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.tempDataReady == 0u || u.tempOpacity <= 0.0) { return color; }

  let cell = tempLatLonToCell(lat, lon);

  // Progressive loading: skip cells not yet loaded
  if (cell >= u.tempLoadedPoints) { return color; }

  // Read directly from bound buffers (no offset math - buffers rebound on slot change)
  let temp0 = tempData0[cell];
  var tempC: f32;
  if (u.tempLerp < -1.5) {
    tempC = temp0;  // Single slot mode: no interpolation
  } else {
    let temp1 = tempData1[cell];
    tempC = mix(temp0, temp1, u.tempLerp);  // Data is already in Celsius
  }

  // Skip invalid data
  if (tempC < -100.0 || tempC > 100.0) { return color; }

  let tempColor = colormapTemp(tempC);
  return vec4f(mix(color.rgb, tempColor, u.tempOpacity), color.a);
}

// Rain/precipitation layer

fn rainLatLonToCell(lat: f32, lon: f32) -> u32 {
  // Reuse temperature's cell lookup (same Gaussian grid)
  return tempLatLonToCell(lat, lon);
}

fn colormapRain(mm: f32) -> vec4f {
  if (mm < 0.1) { return vec4f(0.0); }
  let t = clamp(log(mm + 1.0) / log(51.0), 0.0, 1.0);
  let color = mix(vec3f(0.5, 0.7, 1.0), vec3f(0.2, 0.0, 0.6), t);
  return vec4f(color, u.rainOpacity * min(t + 0.3, 1.0));
}

fn blendRain(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.rainDataReady == 0u || u.rainOpacity <= 0.0) { return color; }
  let cell = rainLatLonToCell(lat, lon);
  let mm = rainData[cell];
  let rainColor = colormapRain(mm);
  if (rainColor.a <= 0.0) { return color; }
  return vec4f(mix(color.rgb, rainColor.rgb, rainColor.a), color.a);
}

// Basemap layer - Earth texture from cubemap

fn blendBasemap(color: vec4f, hitPoint: vec3f) -> vec4f {
  // Use textureSampleLevel to avoid non-uniform control flow issues
  let texColor = textureSampleLevel(basemap, basemapSampler, hitPoint, 0.0);
  return vec4f(mix(color.rgb, texColor.rgb, u.earthOpacity), 1.0);
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

// Grid layer - lat/lon grid overlay

// Original grid function - line width in degrees (world space)
// Lines appear thicker when zoomed in, thinner when zoomed out
// Good for: consistent geographic meaning (0.4° is always 0.4°)
fn blendGridDegrees(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.gridOpacity < 0.01) { return color; }

  let latDeg = degrees(lat);
  let lonDeg = degrees(lon);
  let spacing = 15.0;  // Grid every 15 degrees
  let width = 0.4;     // Line width in degrees (~44km at equator)

  // Distance to nearest grid line (in degrees)
  // fract() gives 0-1, shift by 0.5 to center, abs() for distance from center
  let latLine = abs(fract(latDeg / spacing + 0.5) - 0.5) * spacing;
  let lonLine = abs(fract(lonDeg / spacing + 0.5) - 0.5) * spacing;

  // On grid if within width of either lat or lon line
  let onGrid = min(latLine, lonLine) < width;
  if (onGrid) {
    let gridColor = vec3f(1.0, 1.0, 1.0);
    return vec4f(mix(color.rgb, gridColor, u.gridOpacity * 0.5), color.a);
  }
  return color;
}

// Screen-space grid - line width in pixels (constant visual thickness)
// Lines appear same thickness regardless of zoom level
// Good for: consistent visual appearance, clean UI at any zoom
fn blendGrid(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f) -> vec4f {
  if (u.gridOpacity < 0.01) { return color; }

  let latDeg = degrees(lat);
  let lonDeg = degrees(lon);
  let spacing = 15.0;  // Grid every 15 degrees

  // Calculate per-pixel line width based on actual distance to this point
  // Formula: (2 * tan(fov/2) * distance) / screenHeight = world units per pixel
  let dist = length(hitPoint - u.eyePosition);
  let worldUnitsPerPixel = (2.0 * u.tanFov * dist) / u.resolution.y;
  let degreesPerPixel = worldUnitsPerPixel * (180.0 / 3.14159265);

  let pixelWidth = 3.0;  // Desired line width in screen pixels
  let width = pixelWidth * degreesPerPixel;

  // Longitude degrees shrink toward poles: 1° lon = cos(lat) * 1° lat in world space
  // So we need wider threshold in lon-degrees to get same screen width
  let lonWidth = width / max(cos(lat), 0.01);  // avoid division by zero at poles

  // Distance to nearest grid line (in degrees)
  let latLine = abs(fract(latDeg / spacing + 0.5) - 0.5) * spacing;
  let lonLine = abs(fract(lonDeg / spacing + 0.5) - 0.5) * spacing;

  // Antialiased edges: smoothstep from line center to edge
  // smoothstep(edge1, edge0, x) returns 1 when x < edge0, 0 when x > edge1
  let latFactor = 1.0 - smoothstep(width * 0.5, width, latLine);
  let lonFactor = 1.0 - smoothstep(lonWidth * 0.5, lonWidth, lonLine);
  let gridFactor = max(latFactor, lonFactor);

  if (gridFactor > 0.001) {
    let gridColor = vec3f(1.0, 1.0, 1.0);
    return vec4f(mix(color.rgb, gridColor, gridFactor * u.gridOpacity * 0.5), color.a);
  }
  return color;
}

// Grid text labels - MSDF text at grid line intersections
// Renders coordinate labels (e.g., "15N", "45W") on the globe surface

// Font atlas binding
@group(0) @binding(11) var fontAtlas: texture_2d<f32>;
@group(0) @binding(12) var fontSampler: sampler;

// Atlas constants from IBMPlexMono-Regular.json
const ATLAS_WIDTH: f32 = 117.0;
const ATLAS_HEIGHT: f32 = 111.0;
const DISTANCE_RANGE: f32 = 4.0;

// Layout constants
const GLYPH_WIDTH: f32 = 0.85;        // Horizontal spacing between glyphs
const GLYPH_WIDTH_LETTER: f32 = 1.02; // Extra spacing before direction letter (GLYPH_WIDTH * 1.2)
const LINE_HEIGHT: f32 = 1.3;         // Vertical spacing between rows
const MARGIN_X: f32 = 0.4;            // Horizontal margin from grid line
const MARGIN_Y: f32 = 0.5;            // Vertical margin from grid line
const OFFSET_X: f32 = 0.5;            // X shift for alignment
const OFFSET_Y_NORTH: f32 = 0.5;      // Y shift for N hemisphere
const OFFSET_Y_SOUTH: f32 = -1.0;     // Y shift for S hemisphere
const CHAR_COUNT_OFFSET: f32 = 0.2;   // Extra offset for character count calc
const TEXT_OPACITY: f32 = 0.9;        // Label opacity
const GRID_SPACING: f32 = 15.0;       // Grid line spacing in degrees
const WORLD_SCALE: f32 = 3.0;         // Font size world scale multiplier

// Glyph atlas positions: vec4(x, y, width, height)
const GLYPH_N_POS: vec4f = vec4f(22.0, 84.0, 18.0, 26.0);
const GLYPH_E_POS: vec4f = vec4f(41.0, 84.0, 18.0, 26.0);
const GLYPH_S_POS: vec4f = vec4f(41.0, 56.0, 20.0, 27.0);
const GLYPH_W_POS: vec4f = vec4f(60.0, 84.0, 21.0, 26.0);

const GLYPH_0_POS: vec4f = vec4f(18.0, 0.0, 20.0, 27.0);
const GLYPH_1_POS: vec4f = vec4f(62.0, 54.0, 20.0, 26.0);
const GLYPH_2_POS: vec4f = vec4f(0.0, 29.0, 19.0, 27.0);
const GLYPH_3_POS: vec4f = vec4f(39.0, 0.0, 19.0, 27.0);
const GLYPH_4_POS: vec4f = vec4f(0.0, 85.0, 21.0, 26.0);
const GLYPH_5_POS: vec4f = vec4f(20.0, 28.0, 19.0, 27.0);
const GLYPH_6_POS: vec4f = vec4f(0.0, 57.0, 19.0, 27.0);
const GLYPH_7_POS: vec4f = vec4f(78.0, 27.0, 19.0, 26.0);
const GLYPH_8_POS: vec4f = vec4f(20.0, 56.0, 20.0, 27.0);
const GLYPH_9_POS: vec4f = vec4f(40.0, 28.0, 19.0, 27.0);

// MSDF median function
fn msdfMedian(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

// Sample a glyph at given UV offset from glyph center
fn sampleGlyph(glyphPos: vec4f, localUV: vec2f, screenPxRange: f32) -> f32 {
  if (abs(localUV.x) > 0.5 || abs(localUV.y) > 0.5) {
    return 0.0;
  }

  let atlasUV = vec2f(
    (glyphPos.x + (localUV.x + 0.5) * glyphPos.z) / ATLAS_WIDTH,
    (glyphPos.y + (localUV.y + 0.5) * glyphPos.w) / ATLAS_HEIGHT
  );

  let msdf = textureSampleLevel(fontAtlas, fontSampler, atlasUV, 0.0);
  let sd = msdfMedian(msdf.r, msdf.g, msdf.b);
  let screenPxDistance = screenPxRange * (sd - 0.5);
  return clamp(screenPxDistance + 0.5, 0.0, 1.0);
}

// Get glyph position for a digit 0-9
fn getDigitGlyph(digit: i32) -> vec4f {
  switch (digit) {
    case 0: { return GLYPH_0_POS; }
    case 1: { return GLYPH_1_POS; }
    case 2: { return GLYPH_2_POS; }
    case 3: { return GLYPH_3_POS; }
    case 4: { return GLYPH_4_POS; }
    case 5: { return GLYPH_5_POS; }
    case 6: { return GLYPH_6_POS; }
    case 7: { return GLYPH_7_POS; }
    case 8: { return GLYPH_8_POS; }
    case 9: { return GLYPH_9_POS; }
    default: { return GLYPH_0_POS; }
  }
}

// Render latitude row (e.g., "15N" or "0S")
fn renderLatRow(
  latTens: i32, latOnes: i32, isNorth: bool,
  startX: f32, y: f32, screenPxRange: f32
) -> f32 {
  var opacity = 0.0;
  var x = startX;

  if (latTens > 0) {
    opacity = max(opacity, sampleGlyph(getDigitGlyph(latTens), vec2f(x, y), screenPxRange));
    x -= GLYPH_WIDTH;
  }
  opacity = max(opacity, sampleGlyph(getDigitGlyph(latOnes), vec2f(x, y), screenPxRange));
  x -= GLYPH_WIDTH_LETTER;

  let dirGlyph = select(GLYPH_S_POS, GLYPH_N_POS, isNorth);
  opacity = max(opacity, sampleGlyph(dirGlyph, vec2f(x, y), screenPxRange));

  return opacity;
}

// Render longitude row (e.g., "45E", "120W", or "0E")
fn renderLonRow(
  lonHundreds: i32, lonTens: i32, lonOnes: i32, isEast: bool,
  startX: f32, y: f32, screenPxRange: f32
) -> f32 {
  var opacity = 0.0;
  var x = startX;

  if (lonHundreds > 0) {
    opacity = max(opacity, sampleGlyph(getDigitGlyph(lonHundreds), vec2f(x, y), screenPxRange));
    x -= GLYPH_WIDTH;
  }
  if (lonHundreds > 0 || lonTens > 0) {
    opacity = max(opacity, sampleGlyph(getDigitGlyph(lonTens), vec2f(x, y), screenPxRange));
    x -= GLYPH_WIDTH;
  }
  opacity = max(opacity, sampleGlyph(getDigitGlyph(lonOnes), vec2f(x, y), screenPxRange));
  x -= GLYPH_WIDTH_LETTER;

  let dirGlyph = select(GLYPH_W_POS, GLYPH_E_POS, isEast);
  opacity = max(opacity, sampleGlyph(dirGlyph, vec2f(x, y), screenPxRange));

  return opacity;
}

// Blend grid text labels onto surface
fn blendGridText(color: vec4f, lat: f32, lon: f32, hitPoint: vec3f) -> vec4f {
  if (u.gridOpacity < 0.01) { return color; }

  let latDeg = degrees(lat);
  let lonDeg = degrees(lon);

  // Screen-space metrics
  let dist = length(hitPoint - u.eyePosition);
  let worldUnitsPerPixel = (2.0 * u.tanFov * dist) / u.resolution.y;
  let fontSizeWorld = u.gridFontSize * worldUnitsPerPixel * WORLD_SCALE;
  let screenPxRange = u.gridFontSize / DISTANCE_RANGE;

  // Find nearest grid intersection
  let nearestLat = round(latDeg / GRID_SPACING) * GRID_SPACING;
  let nearestLon = round(lonDeg / GRID_SPACING) * GRID_SPACING;

  // Convert offset to glyph UV space
  let dLat = latDeg - nearestLat;
  let dLon = lonDeg - nearestLon;
  let lonScale = max(cos(lat), 0.01);
  let degToRad = COMMON_PI / 180.0;
  let glyphUV = vec2f(
    (dLon * degToRad * lonScale) / fontSizeWorld,
    -(dLat * degToRad) / fontSizeWorld
  );

  // Extract coordinate digits
  let absLat = i32(abs(nearestLat));
  let absLon = i32(abs(nearestLon));
  let latTens = absLat / 10;
  let latOnes = absLat % 10;
  let lonHundreds = absLon / 100;
  let lonTens = (absLon / 10) % 10;
  let lonOnes = absLon % 10;
  let isNorth = nearestLat >= 0.0;
  let isEast = nearestLon >= 0.0;

  // Character counts for alignment
  let latCharCount = select(2.0, 3.0, latTens > 0);
  let lonCharCount = select(2.0, select(3.0, 4.0, lonHundreds > 0), lonTens > 0 || lonHundreds > 0);

  // Y offset based on hemisphere (computed once)
  let yOffset = select(OFFSET_Y_SOUTH, OFFSET_Y_NORTH, isNorth);
  let baseY = glyphUV.y - select(MARGIN_Y + LINE_HEIGHT, -MARGIN_Y, isNorth) + yOffset;

  var opacity = 0.0;

  if (isEast) {
    // East: left-aligned
    let startX = glyphUV.x - MARGIN_X - OFFSET_X;
    opacity = max(opacity, renderLatRow(latTens, latOnes, isNorth, startX, baseY, screenPxRange));
    opacity = max(opacity, renderLonRow(lonHundreds, lonTens, lonOnes, isEast, startX, baseY + LINE_HEIGHT, screenPxRange));
  } else {
    // West: right-aligned (each row positioned by its char count)
    let endX = glyphUV.x + MARGIN_X;
    let latStartX = endX + (latCharCount + CHAR_COUNT_OFFSET) * GLYPH_WIDTH;
    let lonStartX = endX + (lonCharCount + CHAR_COUNT_OFFSET) * GLYPH_WIDTH;
    opacity = max(opacity, renderLatRow(latTens, latOnes, isNorth, latStartX, baseY, screenPxRange));
    opacity = max(opacity, renderLonRow(lonHundreds, lonTens, lonOnes, isEast, lonStartX, baseY + LINE_HEIGHT, screenPxRange));
  }

  if (opacity < 0.01) {
    return color;
  }

  return vec4f(mix(color.rgb, vec3f(1.0), opacity * TEXT_OPACITY * u.gridOpacity), color.a);
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
  // Additional weather layer opacities
  cloudsOpacity: f32,
  humidityOpacity: f32,
  windOpacity: f32,
  cloudsDataReady: u32,
  humidityDataReady: u32,
  windDataReady: u32,
  weatherPad: vec2f,      // padding to 16-byte alignment
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var basemap: texture_cube<f32>;
@group(0) @binding(2) var basemapSampler: sampler;
@group(0) @binding(3) var<storage, read> gaussianLats: array<f32>;
@group(0) @binding(4) var<storage, read> ringOffsets: array<u32>;
@group(0) @binding(5) var<storage, read> tempData0: array<f32>;  // Slot 0 for interpolation
@group(0) @binding(6) var<storage, read> tempData1: array<f32>;  // Slot 1 for interpolation
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
// Additional weather layer data
@group(0) @binding(15) var<storage, read> cloudsData: array<f32>;
@group(0) @binding(16) var<storage, read> humidityData: array<f32>;
@group(0) @binding(17) var<storage, read> windData: array<f32>;
@group(0) @binding(18) var<storage, read> rainData: array<f32>;
// Logo texture for idle globe display
@group(0) @binding(19) var logoTexture: texture_2d<f32>;
@group(0) @binding(20) var logoSampler: sampler;

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
  color = blendLogo(color, fragPos.xy);   // Logo sprite when idle
  color = blendBasemap(color, hit.point);
  color = blendTemp(color, lat, lon);
  color = blendRain(color, lat, lon);

  // When earth/temp are off, render back-side grid first (visible through transparent front)
  let showBackGrid = u.earthOpacity < 0.01 && u.tempOpacity < 0.01;
  if (showBackGrid) {
    let farHit = raySphereIntersectFar(u.eyePosition, rayDir, EARTH_RADIUS);
    if (farHit.valid) {
      let backLat = asin(farHit.point.y);
      let backLon = atan2(farHit.point.x, farHit.point.z);
      color = blendGrid(color, backLat, backLon, farHit.point);
      color = blendGridText(color, backLat, backLon, farHit.point);
    }
  }

  // Front grid (always on top)
  color = blendGrid(color, lat, lon, hit.point);
  color = blendGridText(color, lat, lon, hit.point);

  // Compute normalized depth from ray hit distance
  // hit.t is distance from camera to globe surface
  // Normalize against camera distance to globe (gives ~0.5-0.7 for typical views)
  let cameraDistance = length(u.eyePosition);
  let normalizedDepth = clamp(hit.t / (cameraDistance * 2.0), 0.0, 1.0);

  return FragmentOutput(color, normalizedDepth);
}