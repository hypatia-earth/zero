// O1280 Gaussian Grid Projection
// Shared projection functions for ECMWF octahedral reduced Gaussian grid
// Uses gaussianLats (2560 latitude bands) and ringOffsets LUTs

// Binary search for Gaussian latitude ring (0-2559)
fn o1280FindRing(lat: f32) -> u32 {
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

// Convert lat/lon to cell index in O1280 grid (~6.6M points)
fn o1280LatLonToCell(lat: f32, lon: f32) -> u32 {
  let ring = o1280FindRing(lat);
  let ringFromPole = select(ring + 1u, 2560u - ring, ring >= 1280u);
  let nPoints = 4u * ringFromPole + 16u;
  var lonNorm = lon;
  if (lonNorm < 0.0) { lonNorm += COMMON_TAU; }
  let lonIdx = u32(floor(lonNorm / COMMON_TAU * f32(nPoints))) % nPoints;
  return ringOffsets[ring] + lonIdx;
}
