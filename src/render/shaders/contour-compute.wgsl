// Marching Squares Compute Shader
// Generates contour lines from 2D scalar field (pressure data)
//
// Two-pass approach:
// Pass 1: Count segments per cell
// Pass 2: Generate line vertices (after prefix sum computes offsets)

struct Uniforms {
  gridWidth: u32,
  gridHeight: u32,
  isovalue: f32,
  earthRadius: f32,
  vertexOffset: u32,  // Base offset for multi-level rendering
  lerp: f32,          // Interpolation factor (0 = grid0, 1 = grid1)
  _pad: vec2<u32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> pressureGrid0: array<f32>;  // Regridded data slot 0
@group(0) @binding(2) var<storage, read_write> segmentCounts: array<u32>;
@group(0) @binding(3) var<storage, read> offsets: array<u32>;  // from prefix sum
@group(0) @binding(4) var<storage, read_write> vertices: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> pressureGrid1: array<f32>;  // Regridded data slot 1

// Segment count per case (0-15)
const SEGMENT_COUNT: array<u32, 16> = array<u32, 16>(
  0, 1, 1, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 0
);

// Edge pairs for each case
// Edges: 0=bottom, 1=right, 2=top, 3=left
// Each vec4: (line1_edge_a, line1_edge_b, line2_edge_a, line2_edge_b)
// -1 means no edge
const EDGE_TABLE: array<vec4<i32>, 16> = array<vec4<i32>, 16>(
  vec4(-1, -1, -1, -1),  // 0:  none
  vec4( 3,  0, -1, -1),  // 1:  bottom-left corner
  vec4( 0,  1, -1, -1),  // 2:  bottom-right corner
  vec4( 3,  1, -1, -1),  // 3:  bottom edge
  vec4( 1,  2, -1, -1),  // 4:  top-right corner
  vec4( 3,  0,  1,  2),  // 5:  saddle (2 lines)
  vec4( 0,  2, -1, -1),  // 6:  right edge
  vec4( 3,  2, -1, -1),  // 7:  all except top-left
  vec4( 2,  3, -1, -1),  // 8:  top-left corner
  vec4( 2,  0, -1, -1),  // 9:  left edge
  vec4( 0,  1,  2,  3),  // 10: saddle (2 lines)
  vec4( 2,  1, -1, -1),  // 11: all except top-right
  vec4( 1,  3, -1, -1),  // 12: top edge
  vec4( 1,  0, -1, -1),  // 13: all except bottom-right
  vec4( 0,  3, -1, -1),  // 14: all except bottom-left
  vec4(-1, -1, -1, -1),  // 15: all inside, no contour
);

// Sample pressure at grid position with interpolation between two timesteps
// x wraps around for longitude continuity (359° → 0°)
fn samplePressure(x: u32, y: u32) -> f32 {
  let wx = x % uniforms.gridWidth;  // Wrap longitude
  let idx = y * uniforms.gridWidth + wx;
  let v0 = pressureGrid0[idx];
  let v1 = pressureGrid1[idx];
  return mix(v0, v1, uniforms.lerp);
}

// Get case index from 4 corner values
fn getCaseIndex(v0: f32, v1: f32, v2: f32, v3: f32, iso: f32) -> u32 {
  var caseIdx = 0u;
  if (v0 > iso) { caseIdx |= 1u; }  // bottom-left
  if (v1 > iso) { caseIdx |= 2u; }  // bottom-right
  if (v2 > iso) { caseIdx |= 4u; }  // top-right
  if (v3 > iso) { caseIdx |= 8u; }  // top-left
  return caseIdx;
}

// Interpolate position on edge
fn interpolateEdge(edge: i32, cellX: u32, cellY: u32, v: array<f32, 4>, iso: f32) -> vec2<f32> {
  var p0: vec2<f32>;
  var p1: vec2<f32>;
  var val0: f32;
  var val1: f32;

  switch(edge) {
    case 0: { // bottom edge
      p0 = vec2(0.0, 0.0); p1 = vec2(1.0, 0.0);
      val0 = v[0]; val1 = v[1];
    }
    case 1: { // right edge
      p0 = vec2(1.0, 0.0); p1 = vec2(1.0, 1.0);
      val0 = v[1]; val1 = v[2];
    }
    case 2: { // top edge
      p0 = vec2(1.0, 1.0); p1 = vec2(0.0, 1.0);
      val0 = v[2]; val1 = v[3];
    }
    case 3: { // left edge
      p0 = vec2(0.0, 1.0); p1 = vec2(0.0, 0.0);
      val0 = v[3]; val1 = v[0];
    }
    default: {
      return vec2(0.0);
    }
  }

  let t = clamp((iso - val0) / (val1 - val0), 0.0, 1.0);
  let localPos = mix(p0, p1, t);
  return localPos + vec2<f32>(f32(cellX), f32(cellY));
}

// Convert grid position to 3D sphere position
fn gridToSphere(gridPos: vec2<f32>) -> vec3<f32> {
  // Wrap x for longitude continuity (wrap column produces x >= gridWidth)
  let wx = gridPos.x - floor(gridPos.x / f32(uniforms.gridWidth)) * f32(uniforms.gridWidth);
  let lon = (wx / f32(uniforms.gridWidth)) * 360.0 - 180.0;
  let lat = 90.0 - (gridPos.y / f32(uniforms.gridHeight - 1u)) * 180.0;

  let latRad = radians(lat);
  let lonRad = radians(lon);

  // Slight offset above globe surface to avoid z-fighting
  let r = uniforms.earthRadius * 1.002;
  let cosLat = cos(latRad);

  return vec3<f32>(
    r * cosLat * cos(lonRad),
    r * sin(latRad),
    r * cosLat * sin(lonRad)
  );
}

// ============================================================
// PASS 1: Count segments per cell
// ============================================================
@compute @workgroup_size(8, 8)
fn countSegments(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let y = id.y;

  // Grid is width x (height-1) cells (extra column for longitude wrap)
  if (x >= uniforms.gridWidth || y >= uniforms.gridHeight - 1u) {
    return;
  }

  // Sample 4 corners
  let v0 = samplePressure(x, y);          // bottom-left
  let v1 = samplePressure(x + 1u, y);     // bottom-right
  let v2 = samplePressure(x + 1u, y + 1u); // top-right
  let v3 = samplePressure(x, y + 1u);     // top-left

  let caseIdx = getCaseIndex(v0, v1, v2, v3, uniforms.isovalue);
  let cellIdx = y * uniforms.gridWidth + x;  // width cells per row (with wrap)

  segmentCounts[cellIdx] = SEGMENT_COUNT[caseIdx];
}

// ============================================================
// PASS 2: Generate line segment vertices
// ============================================================
@compute @workgroup_size(8, 8)
fn generateSegments(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let y = id.y;

  // Grid is width x (height-1) cells (extra column for longitude wrap)
  if (x >= uniforms.gridWidth || y >= uniforms.gridHeight - 1u) {
    return;
  }

  let cellIdx = y * uniforms.gridWidth + x;  // width cells per row (with wrap)
  let count = segmentCounts[cellIdx];

  if (count == 0u) {
    return;
  }

  let offset = offsets[cellIdx];

  // Sample 4 corners again
  let v0 = samplePressure(x, y);
  let v1 = samplePressure(x + 1u, y);
  let v2 = samplePressure(x + 1u, y + 1u);
  let v3 = samplePressure(x, y + 1u);

  let caseIdx = getCaseIndex(v0, v1, v2, v3, uniforms.isovalue);
  var edges = EDGE_TABLE[caseIdx];
  let values = array<f32, 4>(v0, v1, v2, v3);

  // Saddle point disambiguation: check bilinear center value
  // Case 5: corners 0,2 high (0101) - Case 10: corners 1,3 high (1010)
  if (caseIdx == 5u || caseIdx == 10u) {
    let center = (v0 + v1 + v2 + v3) * 0.25;
    let centerHigh = center > uniforms.isovalue;
    // Flip connections when center is low (contours wrap around saddle differently)
    if ((caseIdx == 5u && !centerHigh) || (caseIdx == 10u && !centerHigh)) {
      // Swap edge pairs: (a,b,c,d) → (a,d,c,b) to flip diagonal
      edges = vec4<i32>(edges.x, edges.w, edges.z, edges.y);
    }
  }

  // Base index with level offset
  let baseIdx = uniforms.vertexOffset + offset * 2u;

  // First line segment
  if (edges.x >= 0) {
    let p0 = interpolateEdge(edges.x, x, y, values, uniforms.isovalue);
    let p1 = interpolateEdge(edges.y, x, y, values, uniforms.isovalue);

    let world0 = gridToSphere(p0);
    let world1 = gridToSphere(p1);

    vertices[baseIdx] = vec4<f32>(world0, 1.0);
    vertices[baseIdx + 1u] = vec4<f32>(world1, 1.0);
  }

  // Second line segment (saddle cases 5 and 10)
  if (count > 1u && edges.z >= 0) {
    let p0 = interpolateEdge(edges.z, x, y, values, uniforms.isovalue);
    let p1 = interpolateEdge(edges.w, x, y, values, uniforms.isovalue);

    let world0 = gridToSphere(p0);
    let world1 = gridToSphere(p1);

    vertices[baseIdx + 2u] = vec4<f32>(world0, 1.0);
    vertices[baseIdx + 3u] = vec4<f32>(world1, 1.0);
  }
}
