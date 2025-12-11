// Globe shader - ray-sphere intersection with layer compositing

struct Uniforms {
  viewProjInverse: mat4x4f,  // 64 bytes
  eyePosition: vec3f,         // 12 + 4 pad = 16 bytes
  eyePad: f32,
  resolution: vec2f,          // 8 bytes
  tanFov: f32,                // 4 bytes
  resPad: f32,                // 4 bytes pad = 16 bytes total
  time: f32,                  // 4 bytes
  sunEnabled: u32,            // 4 bytes
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
  tempLoadedPad: f32,     // padding to 16-byte alignment
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var basemap: texture_cube<f32>;
@group(0) @binding(2) var basemapSampler: sampler;
@group(0) @binding(3) var<storage, read> gaussianLats: array<f32>;
@group(0) @binding(4) var<storage, read> ringOffsets: array<u32>;
@group(0) @binding(5) var<storage, read> tempData: array<f32>;  // Large buffer with N slots
@group(0) @binding(6) var<storage, read> rainData: array<f32>;
// Atmosphere LUTs (Bruneton precomputed scattering)
@group(0) @binding(7) var atm_transmittance: texture_2d<f32>;
@group(0) @binding(8) var atm_scattering: texture_3d<f32>;
@group(0) @binding(9) var atm_irradiance: texture_2d<f32>;
@group(0) @binding(10) var atm_sampler: sampler;

const POINTS_PER_SLOT: u32 = 6599680u;  // Points per timestep slot

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;
const EARTH_RADIUS: f32 = 1.0;
const BG_COLOR: vec4f = vec4f(0.086, 0.086, 0.086, 1.0);

// Atmosphere tuning params
const ATM_EXPOSURE: f32 = 4.0;            // Tone mapping exposure (higher = brighter)
const ATM_MIE_REDUCTION: f32 = 0.3;       // Reduce white haze (0 = none, 1 = full Bruneton)
const ATM_NIGHT_BRIGHTNESS: f32 = 0.15;   // Night side darkness (0 = black, 1 = same as day)
const ATM_SURFACE_RADIANCE: f32 = 0.1;    // Earth brightness vs atmosphere (higher = earth shows more)

struct RayHit {
  valid: bool,
  point: vec3f,
  t: f32,
}

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

fn blendBasemap(color: vec4f, hitPoint: vec3f) -> vec4f {
  // Use textureSampleLevel to avoid non-uniform control flow issues
  let texColor = textureSampleLevel(basemap, basemapSampler, hitPoint, 0.0);
  return vec4f(mix(color.rgb, texColor.rgb, u.earthOpacity), 1.0);
}

// blendDayNight removed - atmosphere handles day/night now

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

fn blendSun(color: vec4f, fragCoord: vec2f) -> vec4f {
  if (u.sunEnabled == 0u) { return color; }

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
    return vec4f(u.sunCoreColor, 1.0);
  }

  // Glow falloff - directly outside core
  if (dist < u.sunGlowRadius) {
    let t = 1.0 - (dist - u.sunCoreRadius) / (u.sunGlowRadius - u.sunCoreRadius);
    let glow = u.sunGlowColor * t * t * 0.4;
    return vec4f(color.rgb + glow, 1.0);
  }

  return color;
}

fn blendGrid(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.gridEnabled == 0u) { return color; }
  let latDeg = degrees(lat);
  let lonDeg = degrees(lon);
  let spacing = 15.0;
  let width = 0.4;
  let latLine = abs(fract(latDeg / spacing + 0.5) - 0.5) * spacing;
  let lonLine = abs(fract(lonDeg / spacing + 0.5) - 0.5) * spacing;
  let onGrid = min(latLine, lonLine) < width;
  if (onGrid) {
    let gridColor = vec3f(1.0, 1.0, 1.0);
    return vec4f(mix(color.rgb, gridColor, u.gridOpacity * 0.5), color.a);
  }
  return color;
}

// Binary search for Gaussian latitude ring
fn findRing(lat: f32) -> u32 {
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

fn latLonToCell(lat: f32, lon: f32) -> u32 {
  let ring = findRing(lat);
  let ringFromPole = select(ring + 1u, 2560u - ring, ring >= 1280u);
  let nPoints = 4u * ringFromPole + 16u;
  var lonNorm = lon;
  if (lonNorm < 0.0) { lonNorm += TAU; }
  let lonIdx = u32(floor(lonNorm / TAU * f32(nPoints))) % nPoints;
  return ringOffsets[ring] + lonIdx;
}

fn colormapTemp(tempC: f32) -> vec3f {
  let t = clamp((tempC + 40.0) / 90.0, 0.0, 1.0);
  // Blue -> Cyan -> Green -> Yellow -> Red
  if (t < 0.25) {
    return mix(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 1.0), t * 4.0);
  } else if (t < 0.5) {
    return mix(vec3f(0.0, 1.0, 1.0), vec3f(0.0, 1.0, 0.0), (t - 0.25) * 4.0);
  } else if (t < 0.75) {
    return mix(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 1.0, 0.0), (t - 0.5) * 4.0);
  } else {
    return mix(vec3f(1.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), (t - 0.75) * 4.0);
  }
}

fn colormapRain(mm: f32) -> vec4f {
  if (mm < 0.1) { return vec4f(0.0); }
  let t = clamp(log(mm + 1.0) / log(51.0), 0.0, 1.0);
  let color = mix(vec3f(0.5, 0.7, 1.0), vec3f(0.2, 0.0, 0.6), t);
  return vec4f(color, u.rainOpacity * min(t + 0.3, 1.0));
}

// Read temperature value from slot-based buffer
fn getTempFromSlot(cell: u32, slot: u32) -> f32 {
  let index = slot * POINTS_PER_SLOT + cell;
  return tempData[index];
}

fn blendTemp(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.tempDataReady == 0u || u.tempOpacity <= 0.0) { return color; }
  let cell = latLonToCell(lat, lon);

  // Progressive loading: skip cells not yet loaded
  if (cell >= u.tempLoadedPoints) { return color; }

  // Read from slots and interpolate
  let temp0 = getTempFromSlot(cell, u.tempSlot0);
  let temp1 = getTempFromSlot(cell, u.tempSlot1);
  let tempC = mix(temp0, temp1, u.tempLerp);  // Data is already in Celsius

  // Skip invalid data
  if (tempC < -100.0 || tempC > 100.0) { return color; }

  let tempColor = colormapTemp(tempC);
  return vec4f(mix(color.rgb, tempColor, u.tempOpacity), color.a);
}

fn blendRain(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.rainDataReady == 0u || u.rainOpacity <= 0.0) { return color; }
  let cell = latLonToCell(lat, lon);
  let mm = rainData[cell];
  let rainColor = colormapRain(mm);
  if (rainColor.a <= 0.0) { return color; }
  return vec4f(mix(color.rgb, rainColor.rgb, rainColor.a), color.a);
}

// Tone mapping (Reinhard with exposure)
fn toneMap(radiance: vec3f, exposure: f32) -> vec3f {
  let white_point = vec3f(1.0, 1.0, 1.0);
  return pow(vec3f(1.0) - exp(-radiance / white_point * exposure), vec3f(1.0 / 2.2));
}

@fragment
fn fs_main(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let rayDir = computeRay(fragPos.xy);
  let hit = raySphereIntersect(u.eyePosition, rayDir, EARTH_RADIUS);

  // Convert to km scale for atmosphere (zero uses unit sphere, atmosphere uses 6360km earth)
  let camera_km = u.eyePosition * UNIT_TO_KM;

  if (!hit.valid) {
    // Ray misses earth - render sky/space with atmosphere
    return blendAtmosphereSpace(BG_COLOR, rayDir, camera_km, ATM_EXPOSURE, fragPos);
  }

  let lat = asin(hit.point.y);
  let lon = atan2(hit.point.x, hit.point.z);

  // Layer compositing (back to front)
  var color = vec4f(0.1, 0.1, 0.15, 1.0); // Base dark color
  color = blendBasemap(color, hit.point);
  color = blendTemp(color, lat, lon);
  color = blendRain(color, lat, lon);
  color = blendGrid(color, lat, lon);

  color = blendAtmosphereGlobe(color, hit.point, camera_km, ATM_EXPOSURE);

  return color;
}
