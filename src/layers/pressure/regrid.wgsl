// Re-grid Compute Shader
// Samples O1280 Gaussian grid and outputs to regular lat/lon grid
// Used to convert pressure data from O1280 (~6.6M points) to 1° or 2° grid
//
// O1280 Gaussian grid: Variable points per latitude ring (20-5136 points)
// Output: Regular grid (180x90 @ 2° or 360x180 @ 1°)

struct RegridUniforms {
  outputWidth: u32,   // 180 (2°) or 360 (1°)
  outputHeight: u32,  // 90 (2°) or 180 (1°)
  inputSlot: u32,     // Which slot in pressure buffer to read
  _pad: u32,
}

@group(0) @binding(0) var<uniform> uniforms: RegridUniforms;
@group(0) @binding(1) var<storage, read> pressureData: array<f32>;  // O1280 data
@group(0) @binding(2) var<storage, read> gaussianLats: array<f32>;  // 2560 latitudes
@group(0) @binding(3) var<storage, read> ringOffsets: array<u32>;   // 2560 offsets
@group(0) @binding(4) var<storage, read_write> outputGrid: array<f32>;

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const POINTS_PER_SLOT: u32 = 6599680u;

// Binary search for Gaussian latitude ring (same as temperature.wgsl)
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

// Sample O1280 at lat/lon (radians)
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  DO NOT TOUCH - VERIFIED WORKING FORMULA (2024-12)                        ║
// ║                                                                           ║
// ║  O1280 coordinate system (discovered via synthetic data testing):         ║
// ║  - lonIdx=0 corresponds to 90°E (not 0°!)                                 ║
// ║  - Longitude increases WESTWARD (opposite of standard convention)         ║
// ║  - Formula: lonIdx = (90° - targetLon) / 360° × nPoints                   ║
// ║                                                                           ║
// ║  Changing this will break pressure contour positions vs windy.com         ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
//
fn sampleO1280(lat: f32, lon: f32) -> f32 {
  let ring = findRing(lat);
  let ringFromPole = select(ring + 1u, 2560u - ring, ring >= 1280u);
  let nPoints = 4u * ringFromPole + 16u;

  // O1280 index: 0=90°E, increases westward. DO NOT CHANGE.
  var lonNorm = PI * 0.5 - lon;  // 90° - target_lon (in radians)
  if (lonNorm < 0.0) { lonNorm += TWO_PI; }
  let lonIdx = u32(floor(lonNorm / TWO_PI * f32(nPoints))) % nPoints;

  let cell = ringOffsets[ring] + lonIdx;
  let index = uniforms.inputSlot * POINTS_PER_SLOT + cell;
  return pressureData[index];
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let y = id.y;

  if (x >= uniforms.outputWidth || y >= uniforms.outputHeight) {
    return;
  }

  // Convert grid position to lat/lon (radians)
  // Grid: (0,0) = top-left = (90°N, 180°W)
  // y increases southward, x increases eastward
  let latDeg = 90.0 - f32(y) * (180.0 / f32(uniforms.outputHeight));
  let lonDeg = -180.0 + f32(x) * (360.0 / f32(uniforms.outputWidth));

  let lat = latDeg * PI / 180.0;
  let lon = lonDeg * PI / 180.0;

  // Sample O1280 and write to regular grid
  let pressure = sampleO1280(lat, lon);
  let outIdx = y * uniforms.outputWidth + x;
  outputGrid[outIdx] = pressure;
}
