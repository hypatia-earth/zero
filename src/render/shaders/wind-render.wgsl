// Wind Layer Rendering Shader (T2: Seed Points)
// Renders Fibonacci sphere seed points as dots on the globe
// Part of Pass 2 (Geometry) in Zero's render architecture
//
// Future phases:
// - T3: Wind data integration
// - T4: Particle simulation and trails

struct Uniforms {
  viewProj: mat4x4<f32>,
  eyePosition: vec3<f32>,
  opacity: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
}

struct FragmentOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> seeds: array<vec4<f32>>;

@vertex
fn vertexMain(@builtin(vertex_index) idx: u32) -> VertexOutput {
  let seedPos = seeds[idx].xyz;

  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4<f32>(seedPos, 1.0);
  out.worldPos = seedPos;
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> FragmentOutput {
  // White dots for seed visualization
  let color = vec3<f32>(1.0, 1.0, 1.0);
  let alpha = uniforms.opacity;

  // Compute linear depth matching globe shader
  let hitT = length(in.worldPos - uniforms.eyePosition);
  let cameraDistance = length(uniforms.eyePosition);
  let linearDepth = clamp(hitT / (cameraDistance * 2.0), 0.0, 1.0);

  return FragmentOutput(vec4<f32>(color, alpha), linearDepth);
}
