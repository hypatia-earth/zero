// Chaikin Corner-Cutting Subdivision for Pressure Contours
//
// Processes per-SEGMENT (vertex pairs), outputs 2 line segments per input:
// 1. Main segment (Q, R) - the Chaikin cut points on this edge
// 2. Connection segment (R, Q_next) - connects to next segment in chain
//
// This produces 2× vertex expansion (4 vertices per 2 input vertices).

struct ChaikinUniforms {
  earthRadius: f32,
  inputVertexCount: u32,
  inputVertexOffset: u32,
  outputVertexOffset: u32,
}

@group(0) @binding(0) var<uniform> uniforms: ChaikinUniforms;
@group(0) @binding(1) var<storage, read> inputVertices: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> outputVertices: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> inputNeighbors: array<vec2<i32>>;
@group(0) @binding(4) var<storage, read_write> outputNeighbors: array<vec2<i32>>;

@compute @workgroup_size(256)
fn chaikinSubdivide(@builtin(global_invocation_id) id: vec3<u32>) {
  let segmentIdx = id.x;

  // Number of input segments = inputVertexCount / 2
  let numSegments = uniforms.inputVertexCount / 2u;
  if (segmentIdx >= numSegments) {
    return;
  }

  // Input vertices for this segment
  let v0Idx = uniforms.inputVertexOffset + segmentIdx * 2u;
  let v1Idx = v0Idx + 1u;

  let V0 = inputVertices[v0Idx].xyz;
  let V1 = inputVertices[v1Idx].xyz;
  let pressure = inputVertices[v0Idx].w;

  // Output base: 4 vertices per input segment (2 line segments)
  let outBase = uniforms.outputVertexOffset + segmentIdx * 4u;

  // Skip invalid segments
  if (length(V0) < 0.1 || length(V1) < 0.1) {
    for (var i = 0u; i < 4u; i++) {
      outputVertices[outBase + i] = vec4<f32>(0.0);
      outputNeighbors[outBase + i] = vec2<i32>(-1, -1);
    }
    return;
  }

  // Get V1's next neighbor for computing Q_next (connection point)
  let neighbors1 = inputNeighbors[v1Idx];

  // Standard Chaikin cut points on this edge (V0 -> V1)
  // Q = 1/4 along edge (near V0), R = 3/4 along edge (near V1)
  var Q = 0.75 * V0 + 0.25 * V1;
  var R = 0.25 * V0 + 0.75 * V1;

  // Re-normalize to sphere surface
  Q = normalize(Q) * uniforms.earthRadius * 1.002;
  R = normalize(R) * uniforms.earthRadius * 1.002;

  // Compute Q_next: the Q point of the next segment in the chain
  // This creates the connection between R and the next segment's Q
  var Q_next = vec3<f32>(0.0);
  var hasNextSegment = false;

  if (neighbors1.y >= 0) {
    let V2 = inputVertices[u32(neighbors1.y)].xyz;
    if (length(V2) > 0.1) {
      // Q_next = 0.75*V1 + 0.25*V2 (Chaikin Q point for edge V1->V2)
      Q_next = 0.75 * V1 + 0.25 * V2;
      Q_next = normalize(Q_next) * uniforms.earthRadius * 1.002;
      hasNextSegment = true;
    }
  }

  // Output 4 vertices forming 2 line segments:
  // Segment 0: (Q, R) - the Chaikin subdivision of this edge
  // Segment 1: (R, Q_next) - connection to next segment (or zeros if end of chain)
  outputVertices[outBase + 0u] = vec4<f32>(Q, pressure);
  outputVertices[outBase + 1u] = vec4<f32>(R, pressure);

  if (hasNextSegment) {
    outputVertices[outBase + 2u] = vec4<f32>(R, pressure);
    outputVertices[outBase + 3u] = vec4<f32>(Q_next, pressure);
  } else {
    // End of chain - no connection segment
    outputVertices[outBase + 2u] = vec4<f32>(0.0);
    outputVertices[outBase + 3u] = vec4<f32>(0.0);
  }

  // Build neighbor indices for potential future iterations
  var prevSegmentR: i32 = -1;
  var nextSegmentQ: i32 = -1;

  let neighbors0 = inputNeighbors[v0Idx];
  if (neighbors0.x >= 0) {
    let prevVertexIdx = u32(neighbors0.x);
    let prevLocalIdx = prevVertexIdx - uniforms.inputVertexOffset;
    let prevSegIdx = prevLocalIdx / 2u;
    // Previous segment's Q_next is at outputOffset + prevSegIdx*4 + 3 (chain: ...R → Q_next → Q...)
    prevSegmentR = i32(uniforms.outputVertexOffset + prevSegIdx * 4u + 3u);
  }

  if (neighbors1.y >= 0) {
    let nextVertexIdx = u32(neighbors1.y);
    let nextLocalIdx = nextVertexIdx - uniforms.inputVertexOffset;
    let nextSegIdx = nextLocalIdx / 2u;
    // Next segment's Q is at outputOffset + nextSegIdx*4 + 0
    nextSegmentQ = i32(uniforms.outputVertexOffset + nextSegIdx * 4u);
  }

  // Store neighbors for all 4 vertices to support multi-pass
  // Logical chain: Q → R → Q_next → [next seg's Q] (R_dup is just for rendering)
  outputNeighbors[outBase + 0u] = vec2<i32>(prevSegmentR, i32(outBase + 1u));  // Q: prev=prevSeg's R, next=R
  outputNeighbors[outBase + 1u] = vec2<i32>(i32(outBase + 0u), i32(outBase + 3u));  // R: prev=Q, next=Q_next (skip R_dup)
  outputNeighbors[outBase + 2u] = vec2<i32>(i32(outBase + 1u), i32(outBase + 3u));  // R_dup: prev=R, next=Q_next
  outputNeighbors[outBase + 3u] = vec2<i32>(i32(outBase + 1u), nextSegmentQ);  // Q_next: prev=R, next=nextSeg's Q
}
