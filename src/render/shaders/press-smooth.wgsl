// Chaikin Smoothing for Pressure Contours
//
// For each vertex, find neighbors along the contour and average positions.
// Shared endpoints (same grid edge from adjacent cells) must move together.
//
// To keep shared vertices connected:
// - Find own segment partner (other end of segment in same cell)
// - Find adjacent cell's segment partner (via shared edge)
// - Average toward the midpoint of both partners

struct SmoothUniforms {
  gridWidth: u32,
  gridHeight: u32,
  numCells: u32,
  earthRadius: f32,
}

@group(0) @binding(0) var<uniform> uniforms: SmoothUniforms;
@group(0) @binding(1) var<storage, read> inputVertices: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> outputVertices: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> edgeToVertex: array<i32>;  // -1 = no vertex

fn getEdgeIndex(cellX: u32, cellY: u32, edge: u32) -> u32 {
  let cellIdx = cellY * uniforms.gridWidth + cellX;
  return cellIdx * 4u + edge;
}

// Get the adjacent cell's edge that shares this boundary
fn getAdjacentEdge(cellX: u32, cellY: u32, edge: u32) -> vec3<i32> {
  var adjX = i32(cellX);
  var adjY = i32(cellY);
  var adjEdge: u32;

  switch(edge) {
    case 0u: { adjY -= 1; adjEdge = 2u; }  // bottom → neighbor's top
    case 1u: { adjX += 1; adjEdge = 3u; }  // right → neighbor's left
    case 2u: { adjY += 1; adjEdge = 0u; }  // top → neighbor's bottom
    case 3u: { adjX -= 1; adjEdge = 1u; }  // left → neighbor's right
    default: { return vec3<i32>(-1); }
  }

  // Bounds check (latitude)
  if (adjY < 0 || adjY >= i32(uniforms.gridHeight - 1u)) {
    return vec3<i32>(-1);
  }

  // Longitude wraps
  if (adjX < 0) { adjX += i32(uniforms.gridWidth); }
  if (adjX >= i32(uniforms.gridWidth)) { adjX -= i32(uniforms.gridWidth); }

  return vec3<i32>(adjX, adjY, i32(adjEdge));
}

// Get segment partner index (vertices stored in pairs)
fn getSegmentPartner(vIdx: u32) -> u32 {
  return select(vIdx - 1u, vIdx + 1u, (vIdx & 1u) == 0u);
}

@compute @workgroup_size(8, 8)
fn smoothEdges(@builtin(global_invocation_id) id: vec3<u32>) {
  let cellX = id.x;
  let cellY = id.y;

  if (cellX >= uniforms.gridWidth || cellY >= uniforms.gridHeight - 1u) {
    return;
  }

  // Process all 4 edges of this cell
  for (var edge = 0u; edge < 4u; edge++) {
    let edgeIdx = getEdgeIndex(cellX, cellY, edge);
    let vertexIdx = edgeToVertex[edgeIdx];

    if (vertexIdx < 0) {
      continue;  // No crossing on this edge
    }

    let vIdx = u32(vertexIdx);
    let pos = inputVertices[vIdx].xyz;

    // Skip invalid/zero vertices
    if (length(pos) < 0.1) {
      outputVertices[vIdx] = inputVertices[vIdx];
      continue;
    }

    // Get own segment partner
    let partnerIdx = getSegmentPartner(vIdx);
    let partnerPos = inputVertices[partnerIdx].xyz;

    var neighborSum = partnerPos;
    var neighborCount = 1.0;

    // Check if partner is valid
    if (length(partnerPos) < 0.1) {
      outputVertices[vIdx] = inputVertices[vIdx];
      continue;
    }

    // Find adjacent cell's segment partner (the other contour neighbor)
    let adj = getAdjacentEdge(cellX, cellY, edge);
    if (adj.x >= 0) {
      let adjEdgeIdx = getEdgeIndex(u32(adj.x), u32(adj.y), u32(adj.z));
      let adjVertexIdx = edgeToVertex[adjEdgeIdx];

      if (adjVertexIdx >= 0) {
        // Adjacent cell has a vertex on the shared edge
        // Get ITS segment partner (the other neighbor along contour)
        let adjPartnerIdx = getSegmentPartner(u32(adjVertexIdx));
        let adjPartnerPos = inputVertices[adjPartnerIdx].xyz;

        if (length(adjPartnerPos) > 0.1) {
          neighborSum += adjPartnerPos;
          neighborCount += 1.0;
        }
      }
    }

    // Average neighbor positions
    let avgNeighbor = neighborSum / neighborCount;

    // Chaikin-style: pull toward average of neighbors
    let smoothed = 0.75 * pos + 0.25 * avgNeighbor;

    // Re-normalize to sphere surface
    let normalized = normalize(smoothed) * uniforms.earthRadius * 1.002;
    outputVertices[vIdx] = vec4<f32>(normalized, 1.0);
  }
}
