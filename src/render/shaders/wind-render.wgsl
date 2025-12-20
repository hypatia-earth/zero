// Wind Layer Rendering Shader (T3: Surface Curves)
// Renders wind lines traced on sphere surface using Rodrigues rotation
// Part of Pass 2 (Geometry) in Zero's render architecture

struct Uniforms {
  viewProj: mat4x4<f32>,
  eyePosition: vec3<f32>,
  opacity: f32,
}

struct LinePoint {
  position: vec3<f32>,
  speed: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) speed: f32,
}

struct FragmentOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> linePoints: array<LinePoint>;

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIdx: u32,
  @builtin(instance_index) instanceIdx: u32
) -> VertexOutput {
  // Using line-list: each segment needs 2 vertices (start, end)
  // vertexIdx 0,1 → segment 0 (points 0,1)
  // vertexIdx 2,3 → segment 1 (points 1,2)
  // etc.
  let segmentsPerLine = 32u;
  let segmentIdx = vertexIdx / 2u;      // Which segment within this line
  let isEnd = vertexIdx % 2u;           // 0 = start vertex, 1 = end vertex
  let pointInLine = segmentIdx + isEnd; // Point index within line

  let pointIdx = instanceIdx * segmentsPerLine + pointInLine;
  let point = linePoints[pointIdx];

  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4<f32>(point.position, 1.0);
  out.worldPos = point.position;
  out.speed = point.speed;
  return out;
}

// Speed-to-color mapping (blue → cyan → green → yellow → red)
fn speedToColor(speed: f32) -> vec3<f32> {
  // Normalize speed: 0-40 m/s range (hurricane force ~33 m/s)
  let t = clamp(speed / 40.0, 0.0, 1.0);

  // 5-stop color ramp
  if (t < 0.25) {
    let s = t / 0.25;
    return mix(vec3<f32>(0.2, 0.4, 1.0), vec3<f32>(0.2, 0.8, 1.0), s);  // blue → cyan
  } else if (t < 0.5) {
    let s = (t - 0.25) / 0.25;
    return mix(vec3<f32>(0.2, 0.8, 1.0), vec3<f32>(0.2, 1.0, 0.4), s);  // cyan → green
  } else if (t < 0.75) {
    let s = (t - 0.5) / 0.25;
    return mix(vec3<f32>(0.2, 1.0, 0.4), vec3<f32>(1.0, 1.0, 0.2), s);  // green → yellow
  } else {
    let s = (t - 0.75) / 0.25;
    return mix(vec3<f32>(1.0, 1.0, 0.2), vec3<f32>(1.0, 0.3, 0.2), s);  // yellow → red
  }
}

@fragment
fn fragmentMain(in: VertexOutput) -> FragmentOutput {
  // Linear depth with offset to render slightly in front of globe surface
  let hitT = length(in.worldPos - uniforms.eyePosition);
  let cameraDistance = length(uniforms.eyePosition);
  let linearDepth = clamp(hitT / (cameraDistance * 2.0), 0.0, 1.0);
  let depthOffset = 0.0001;

  // Color based on wind speed
  let color = speedToColor(in.speed);

  return FragmentOutput(vec4<f32>(color, uniforms.opacity), linearDepth - depthOffset);
}
