// Wind Layer Compute Shader (T3: Surface Curves)
// Traces wind lines on sphere surface using Rodrigues rotation
// Each line follows wind field with on-sphere geodesic movement

struct ComputeUniforms {
  lineCount: u32,
  segments: u32,
  stepFactor: f32,
  windU: f32,  // Test: uniform wind (eastward component)
  windV: f32,  // Test: uniform wind (northward component)
}

struct LinePoint {
  position: vec3<f32>,
  speed: f32,
}

@group(0) @binding(0) var<uniform> uniforms: ComputeUniforms;
@group(0) @binding(1) var<storage, read> seeds: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> linePoints: array<LinePoint>;

// Rodrigues rotation: rotate point 'pos' around 'axis' by 'angle'
fn rodrigues(pos: vec3<f32>, axis: vec3<f32>, angle: f32) -> vec3<f32> {
  let cosA = cos(angle);
  let sinA = sin(angle);
  return pos * cosA + cross(axis, pos) * sinA + axis * dot(axis, pos) * (1.0 - cosA);
}

// Convert lat/lon wind (U,V) to 3D tangent vector at position 'pos'
// U = eastward, V = northward
fn windToTangent(pos: vec3<f32>, u: f32, v: f32) -> vec3<f32> {
  // East direction: perpendicular to north pole and position
  let north = vec3<f32>(0.0, 1.0, 0.0);
  let east = normalize(cross(north, pos));

  // North direction: tangent to meridian
  let northDir = normalize(cross(pos, east));

  // Combine U (east) and V (north) components
  return normalize(u * east + v * northDir);
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

    // Store current position and speed
    let speed = length(vec2<f32>(uniforms.windU, uniforms.windV));
    linePoints[pointIdx] = LinePoint(pos, speed);

    // Get wind direction at current position (uniform test wind)
    let windDir = windToTangent(pos, uniforms.windU, uniforms.windV);

    // Rotation axis: perpendicular to position and wind direction
    let axis = normalize(cross(pos, windDir));

    // Rotate position along sphere surface
    pos = normalize(rodrigues(pos, axis, stepSize));
  }
}
