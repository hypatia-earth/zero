// Contour Line Rendering Shader
// Renders 1px lines with day/night tinting
//
// See: zero-feat-pressure-contours-webgpu.md

struct Uniforms {
  viewProj: mat4x4<f32>,
  sunDirection: vec3<f32>,
  opacity: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> vertices: array<vec4<f32>>;

@vertex
fn vertexMain(@builtin(vertex_index) idx: u32) -> VertexOutput {
  let worldPos = vertices[idx].xyz;

  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  out.worldPos = worldPos;
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  // Day/night tinting
  let surfaceNormal = normalize(in.worldPos);
  let sunDot = dot(surfaceNormal, uniforms.sunDirection);
  let dayFactor = smoothstep(-0.1, 0.2, sunDot);

  let dayColor = vec3<f32>(0.8, 0.8, 0.8);
  let nightColor = vec3<f32>(0.3, 0.3, 0.35);
  let color = mix(nightColor, dayColor, dayFactor);

  return vec4<f32>(color, uniforms.opacity);
}
