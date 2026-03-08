// O1280 Gaussian Grid Projection
// Shared projection functions for ECMWF octahedral reduced Gaussian grid

import package::aurora::shaders::common::COMMON_TAU;

// Packed: gaussianLats (f32 bits) + ringOffsets (u32) interleaved as vec2<u32>
@group(0) @binding(3) var<storage, read> gaussianGrid: array<vec2<u32>>;

fn getGaussianLat(ring: u32) -> f32 { return bitcast<f32>(gaussianGrid[ring].x); }
fn getRingOffset(ring: u32) -> u32  { return gaussianGrid[ring].y; }

// Binary search for Gaussian latitude ring (0-2559)
fn o1280FindRing(lat: f32) -> u32 {
  var lo: u32 = 0u;
  var hi: u32 = 2559u;
  while (lo < hi) {
    let mid = (lo + hi) / 2u;
    if (getGaussianLat(mid) > lat) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// Convert lat/lon to cell index in O1280 grid (~6.6M points)
fn o1280LatLonToCell(lat: f32, lon: f32) -> u32 {
  let ring = o1280FindRing(lat);
  let ringFromPole = select(ring + 1u, 2560u - ring, ring >= 1280u);
  let nPoints = 4u * ringFromPole + 16u;
  var lonNorm = lon;
  if (lonNorm < 0.0) { lonNorm += COMMON_TAU; }
  let lonIdx = u32(floor(lonNorm / COMMON_TAU * f32(nPoints))) % nPoints;
  return getRingOffset(ring) + lonIdx;
}
