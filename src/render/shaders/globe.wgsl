// Globe shader - ray-sphere intersection with layer compositing

struct Uniforms {
  viewProjInverse: mat4x4f,  // 64 bytes
  eyePosition: vec3f,         // 12 + 4 pad = 16 bytes
  eyePad: f32,
  resolution: vec2f,          // 8 + 8 pad = 16 bytes
  resPad: vec2f,
  time: f32,                  // 4 bytes
  sunEnabled: u32,            // 4 bytes
  sunPad: vec2f,              // 8 bytes pad for vec3f alignment
  sunDirection: vec3f,        // 12 + 4 pad = 16 bytes
  sunDirPad: f32,
  gridEnabled: u32,           // remaining fields tightly packed
  gridOpacity: f32,
  earthOpacity: f32,
  tempOpacity: f32,
  rainOpacity: f32,
  tempDataReady: u32,
  rainDataReady: u32,
  tempLerp: f32,          // interpolation factor 0-1 between tempData0 and tempData1
  tempLoadedPoints: u32,  // progressive loading: cells 0..N are valid
  tempLoadedPad: vec3f,   // padding to 16-byte alignment
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var basemap: texture_cube<f32>;
@group(0) @binding(2) var basemapSampler: sampler;
@group(0) @binding(3) var<storage, read> gaussianLats: array<f32>;
@group(0) @binding(4) var<storage, read> ringOffsets: array<u32>;
@group(0) @binding(5) var<storage, read> tempData0: array<f32>;
@group(0) @binding(6) var<storage, read> tempData1: array<f32>;
@group(0) @binding(7) var<storage, read> rainData: array<f32>;

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;
const EARTH_RADIUS: f32 = 1.0;
const BG_COLOR: vec4f = vec4f(0.086, 0.086, 0.086, 1.0);

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

  // FOV = 75 degrees, tan(37.5°) ≈ 0.767
  let tanFov = 0.76732698797896544;
  let aspect = u.resolution.x / u.resolution.y;

  // Compute ray direction
  let rayDir = normalize(
    forward +
    right * ndc.x * tanFov * aspect +
    up * ndc.y * tanFov
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

fn blendDayNight(color: vec4f, hitPoint: vec3f) -> vec4f {
  if (u.sunEnabled == 0u) { return color; }
  let sunDot = dot(normalize(hitPoint), u.sunDirection);
  let dayFactor = smoothstep(-0.1, 0.1, sunDot);
  let brightness = mix(0.3, 1.0, dayFactor);
  return vec4f(color.rgb * brightness, color.a);
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

fn blendTemp(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (u.tempDataReady == 0u || u.tempOpacity <= 0.0) { return color; }
  let cell = latLonToCell(lat, lon);

  // Progressive loading: skip cells not yet loaded
  if (cell >= u.tempLoadedPoints) { return color; }

  // Read from both buffers and interpolate
  let temp0 = tempData0[cell];
  let temp1 = tempData1[cell];
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

@fragment
fn fs_main(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let rayDir = computeRay(fragPos.xy);
  let hit = raySphereIntersect(u.eyePosition, rayDir, EARTH_RADIUS);

  if (!hit.valid) {
    return BG_COLOR;
  }

  let lat = asin(hit.point.y);
  let lon = atan2(hit.point.x, hit.point.z);

  // Layer compositing (back to front)
  var color = vec4f(0.1, 0.1, 0.15, 1.0); // Base dark color
  color = blendBasemap(color, hit.point);
  color = blendTemp(color, lat, lon);
  color = blendRain(color, lat, lon);
  color = blendDayNight(color, hit.point);
  color = blendGrid(color, lat, lon);

  return color;
}
