// Chaikin Corner-Cutting Subdivision for Pressure Contours
//
// Processes per-SEGMENT (vertex pairs), outputs 2 corner segments per input:
// 1. Corner around first vertex (Q0, R0)
// 2. Corner around second vertex (Q1, R1)
//
// This produces 2× vertex expansion. Middle edges are implicitly connected
// through chain neighbors from adjacent segments.

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

  // Output base: 4 vertices per input segment (2 corner segments)
  let outBase = uniforms.outputVertexOffset + segmentIdx * 4u;

  // Skip invalid segments
  if (length(V0) < 0.1 || length(V1) < 0.1) {
    for (var i = 0u; i < 4u; i++) {
      outputVertices[outBase + i] = vec4<f32>(0.0);
      outputNeighbors[outBase + i] = vec2<i32>(-1, -1);
    }
    return;
  }

  // Get neighbors for chain traversal
  // V0 (even): neighbors = (prevChain, V1)
  // V1 (odd): neighbors = (V0, nextChain)
  let neighbors0 = inputNeighbors[v0Idx];
  let neighbors1 = inputNeighbors[v1Idx];


  // Get chain neighbor positions
  var prevPos = V0;  // Default to self if no chain neighbor
  var nextPos = V1;

  if (neighbors0.x >= 0) {
    let p = inputVertices[u32(neighbors0.x)].xyz;
    if (length(p) > 0.1) {
      prevPos = p;
    }
  }

  if (neighbors1.y >= 0) {
    let p = inputVertices[u32(neighbors1.y)].xyz;
    if (length(p) > 0.1) {
      nextPos = p;
    }
  }

  // Compute Chaikin subdivision points for both corners
  // Corner around V0: Q0 on (prev,V0) edge, R0 on (V0,V1) edge
  // Corner around V1: Q1 on (V0,V1) edge, R1 on (V1,next) edge
  var Q0 = 0.25 * prevPos + 0.75 * V0;
  var R0 = 0.75 * V0 + 0.25 * V1;
  var Q1 = 0.25 * V0 + 0.75 * V1;
  var R1 = 0.75 * V1 + 0.25 * nextPos;

  // Re-normalize to sphere surface
  Q0 = normalize(Q0) * uniforms.earthRadius * 1.002;
  R0 = normalize(R0) * uniforms.earthRadius * 1.002;
  Q1 = normalize(Q1) * uniforms.earthRadius * 1.002;
  R1 = normalize(R1) * uniforms.earthRadius * 1.002;

  // Output 4 vertices forming 2 corner segments:
  // Segment 1: (Q0, R0) - corner around V0
  // Segment 2: (Q1, R1) - corner around V1
  outputVertices[outBase + 0u] = vec4<f32>(Q0, pressure);
  outputVertices[outBase + 1u] = vec4<f32>(R0, pressure);
  outputVertices[outBase + 2u] = vec4<f32>(Q1, pressure);
  outputVertices[outBase + 3u] = vec4<f32>(R1, pressure);

  // Build neighbor indices for next iteration
  // Output vertices form segment pairs: (outBase, outBase+1) and (outBase+2, outBase+3)
  // Chain connectivity for next pass:
  // - Q0's prev connects to previous segment's R1
  // - R1's next connects to next segment's Q0

  // Find chain neighbor segment indices
  var prevSegmentR1: i32 = -1;
  var nextSegmentQ0: i32 = -1;

  // Previous segment in chain (if V0 has a chain neighbor)
  if (neighbors0.x >= 0) {
    let prevVertexIdx = u32(neighbors0.x);
    // The neighbor belongs to a different segment - find which one
    // prevVertexIdx is in the input buffer, need to map to output
    let prevLocalIdx = prevVertexIdx - uniforms.inputVertexOffset;
    let prevSegIdx = prevLocalIdx / 2u;
    let isOddVertex = (prevLocalIdx & 1u) == 1u;
    // Previous segment's R1 is at outputOffset + prevSegIdx*4 + 3
    prevSegmentR1 = i32(uniforms.outputVertexOffset + prevSegIdx * 4u + 3u);
  }

  // Next segment in chain (if V1 has a chain neighbor)
  if (neighbors1.y >= 0) {
    let nextVertexIdx = u32(neighbors1.y);
    let nextLocalIdx = nextVertexIdx - uniforms.inputVertexOffset;
    let nextSegIdx = nextLocalIdx / 2u;
    // Next segment's Q0 is at outputOffset + nextSegIdx*4 + 0
    nextSegmentQ0 = i32(uniforms.outputVertexOffset + nextSegIdx * 4u);
  }

  // Store neighbors for output vertices
  // Segment 1 (Q0, R0): Q0.prev = prevSeg's R1, Q0.next = R0, R0.prev = Q0, R0.next = Q1
  // Segment 2 (Q1, R1): Q1.prev = R0, Q1.next = R1, R1.prev = Q1, R1.next = nextSeg's Q0
  outputNeighbors[outBase + 0u] = vec2<i32>(prevSegmentR1, i32(outBase + 1u));      // Q0
  outputNeighbors[outBase + 1u] = vec2<i32>(i32(outBase + 0u), i32(outBase + 2u));  // R0
  outputNeighbors[outBase + 2u] = vec2<i32>(i32(outBase + 1u), i32(outBase + 3u));  // Q1
  outputNeighbors[outBase + 3u] = vec2<i32>(i32(outBase + 2u), nextSegmentQ0);      // R1
}
