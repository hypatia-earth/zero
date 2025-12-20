// Wind Layer Rendering Shader (T1: Minimal Scaffolding)
// Renders a simple white quad to verify toggle/opacity functionality
// Part of Pass 2 (Geometry) in Zero's render architecture
//
// Future phases:
// - T2: Particle compute pipeline
// - T3: Wind data integration
// - T4: Particle rendering with trails

struct Uniforms {
  viewProj: mat4x4<f32>,
  eyePosition: vec3<f32>,
  opacity: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(@location(0) pos: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4<f32>(pos, 0.5, 1.0);  // NDC coordinates, mid-depth
  out.uv = pos * 0.5 + 0.5;  // Convert from [-1,1] to [0,1]
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  // Simple white color with uniform opacity
  // This will be visible when wind layer is enabled
  return vec4<f32>(1.0, 1.0, 1.0, uniforms.opacity * 0.3);  // 30% max opacity for testing
}
