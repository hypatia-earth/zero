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

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> linePoints: array<LinePoint>;

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIdx: u32,
  @builtin(instance_index) instanceIdx: u32
) -> VertexOutput {
  // Each instance is a line, vertexIdx is position within line
  let segmentsPerLine = 32u;
  let pointIdx = instanceIdx * segmentsPerLine + vertexIdx;
  let point = linePoints[pointIdx];

  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4<f32>(point.position, 1.0);
  out.worldPos = point.position;
  out.speed = point.speed;
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 1.0, 1.0, uniforms.opacity);
}
