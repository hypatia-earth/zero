// Laplacian Smoothing for Pressure Contours
//
// Each vertex finds its two contour neighbors:
// 1. Segment partner (other end of line segment in same cell)
// 2. Adjacent vertex found via shared grid edge
//
// Uses Taubin-style smoothing to reduce shrinkage:
// - Odd iterations: smooth toward neighbors (shrink)
// - Even iterations: smooth away from neighbors (inflate)

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

// Try all 4 adjacent cells to find the other contour neighbor
fn findSecondNeighbor(cellX: u32, cellY: u32, myEdge: u32, myPartnerPos: vec3<f32>) -> vec3<f32> {
  // Check the adjacent cell on our edge first (most likely)
  let adj = getAdjacentEdge(cellX, cellY, myEdge);
  if (adj.x >= 0) {
    let adjEdgeIdx = getEdgeIndex(u32(adj.x), u32(adj.y), u32(adj.z));
    let adjVertexIdx = edgeToVertex[adjEdgeIdx];
    if (adjVertexIdx >= 0) {
      let adjPartnerIdx = getSegmentPartner(u32(adjVertexIdx));
      let adjPartnerPos = inputVertices[adjPartnerIdx].xyz;
      if (length(adjPartnerPos) > 0.1) {
        return adjPartnerPos;
      }
    }
  }

  // Fallback: check all 4 edges of adjacent cells
  for (var e = 0u; e < 4u; e++) {
    if (e == myEdge) { continue; }  // Already checked
    let adj2 = getAdjacentEdge(cellX, cellY, e);
    if (adj2.x >= 0) {
      let adj2EdgeIdx = getEdgeIndex(u32(adj2.x), u32(adj2.y), u32(adj2.z));
      let adj2VertexIdx = edgeToVertex[adj2EdgeIdx];
      if (adj2VertexIdx >= 0) {
        let adj2PartnerIdx = getSegmentPartner(u32(adj2VertexIdx));
        let adj2PartnerPos = inputVertices[adj2PartnerIdx].xyz;
        // Check if this is a different neighbor (not our segment partner)
        if (length(adj2PartnerPos) > 0.1 && distance(adj2PartnerPos, myPartnerPos) > 0.001) {
          return adj2PartnerPos;
        }
      }
    }
  }

  return vec3<f32>(0.0);  // Not found
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
      continue;
    }

    let vIdx = u32(vertexIdx);
    let pos = inputVertices[vIdx].xyz;

    // Skip invalid/zero vertices
    if (length(pos) < 0.1) {
      outputVertices[vIdx] = inputVertices[vIdx];
      continue;
    }

    // Get segment partner (neighbor #1)
    let partnerIdx = getSegmentPartner(vIdx);
    let partnerPos = inputVertices[partnerIdx].xyz;

    if (length(partnerPos) < 0.1) {
      outputVertices[vIdx] = inputVertices[vIdx];
      continue;
    }

    // Find second neighbor via adjacent cells
    let neighbor2Pos = findSecondNeighbor(cellX, cellY, edge, partnerPos);

    var avgNeighbor: vec3<f32>;
    var smoothFactor: f32;

    if (length(neighbor2Pos) > 0.1) {
      // Two neighbors: full smoothing
      avgNeighbor = (partnerPos + neighbor2Pos) * 0.5;
      smoothFactor = 0.3;  // Gentler than 0.25 to reduce shrinkage
    } else {
      // One neighbor: very light smoothing to preserve position
      avgNeighbor = partnerPos;
      smoothFactor = 0.1;
    }

    // Laplacian: move toward average of neighbors
    let smoothed = mix(pos, avgNeighbor, smoothFactor);

    // Re-normalize to sphere surface, preserve pressure value in w
    let normalized = normalize(smoothed) * uniforms.earthRadius * 1.002;
    let w = inputVertices[vIdx].w;
    outputVertices[vIdx] = vec4<f32>(normalized, w);
  }
}
