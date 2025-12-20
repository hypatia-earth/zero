// Wind Layer Compute Shader (T4: Hurricane Projection)
// Traces wind lines on sphere surface using Rodrigues rotation
// Samples O1280 hurricane test data to drive wind field

struct ComputeUniforms {
  lineCount: u32,
  segments: u32,
  stepFactor: f32,
  _pad: u32,
}

struct LinePoint {
  position: vec3<f32>,
  speed: f32,
}

@group(0) @binding(0) var<uniform> uniforms: ComputeUniforms;
@group(0) @binding(1) var<storage, read> seeds: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> windU: array<f32>;
@group(0) @binding(3) var<storage, read> windV: array<f32>;
@group(0) @binding(4) var<storage, read> gaussianLats: array<f32>;
@group(0) @binding(5) var<storage, read> ringOffsets: array<u32>;
@group(0) @binding(6) var<storage, read_write> linePoints: array<LinePoint>;

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;

// Convert Cartesian position to lat/lon (degrees)
fn cartesianToLatLon(pos: vec3f) -> vec2f {
  let lat = asin(clamp(pos.y, -1.0, 1.0)) * 180.0 / PI;
  let lon = atan2(pos.x, pos.z) * 180.0 / PI;
  return vec2f(lat, lon);
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

// Sample O1280 grid at lat/lon (radians)
fn sampleO1280(lat: f32, lon: f32) -> vec2f {
  let ring = findRing(lat);
  let ringFromPole = select(ring + 1u, 2560u - ring, ring >= 1280u);
  let nPoints = 4u * ringFromPole + 16u;

  var lonNorm = lon;
  if (lonNorm < 0.0) { lonNorm += TWO_PI; }
  let lonIdx = u32(floor(lonNorm / TWO_PI * f32(nPoints))) % nPoints;

  let cell = ringOffsets[ring] + lonIdx;
  return vec2f(windU[cell], windV[cell]);
}

// Rodrigues rotation: rotate point 'pos' around 'axis' by 'angle'
fn rodrigues(pos: vec3<f32>, axis: vec3<f32>, angle: f32) -> vec3<f32> {
  let cosA = cos(angle);
  let sinA = sin(angle);
  return pos * cosA + cross(axis, pos) * sinA + axis * dot(axis, pos) * (1.0 - cosA);
}

// Convert lat/lon wind (U,V) to 3D tangent vector at position 'pos'
// U = eastward, V = northward
// Returns east direction if wind is zero (fallback to avoid NaN)
fn windToTangent(pos: vec3<f32>, u: f32, v: f32) -> vec3<f32> {
  // East direction: perpendicular to north pole and position
  let north = vec3<f32>(0.0, 1.0, 0.0);
  let crossNP = cross(north, pos);
  let crossLen = length(crossNP);

  // Handle polar singularity: at poles, cross(north, pos) → 0
  var east: vec3<f32>;
  if (crossLen < 0.001) {
    east = vec3<f32>(1.0, 0.0, 0.0);  // Arbitrary tangent at pole
  } else {
    east = crossNP / crossLen;
  }

  // North direction: tangent to meridian
  let northDir = normalize(cross(pos, east));

  // Combine U (east) and V (north) components
  let windVec = u * east + v * northDir;
  let windLen = length(windVec);

  // Avoid NaN from normalizing zero vector
  if (windLen < 0.001) {
    return east;  // Fallback: move east when calm
  }
  return windVec / windLen;
}

@compute @workgroup_size(64)
fn computeMain(@builtin(global_invocation_id) id: vec3<u32>) {
  let lineIdx = id.x;
  if (lineIdx >= uniforms.lineCount) {
    return;
  }

  // Start from seed position
  var pos = normalize(seeds[lineIdx].xyz);

  // Step size: proportional to stepFactor
  // Smaller values = smoother curves, larger values = faster movement
  let stepSize = uniforms.stepFactor;

  // Trace line segments
  for (var i = 0u; i < uniforms.segments; i++) {
    let pointIdx = lineIdx * uniforms.segments + i;

    // Convert position to lat/lon
    let latLon = cartesianToLatLon(pos);
    let latRad = latLon.x * PI / 180.0;
    let lonRad = latLon.y * PI / 180.0;

    // Sample O1280 wind data at current position
    let wind = sampleO1280(latRad, lonRad);
    let u = wind.x;
    let v = wind.y;

    // Store current position and speed
    let speed = length(vec2<f32>(u, v));
    linePoints[pointIdx] = LinePoint(pos, speed);

    // Get wind direction at current position
    let windDir = windToTangent(pos, u, v);

    // Rotation axis: perpendicular to position and wind direction
    let axis = normalize(cross(pos, windDir));

    // Rotate position along sphere surface
    pos = normalize(rodrigues(pos, axis, stepSize));
  }
}
