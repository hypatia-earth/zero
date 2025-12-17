// Contour Line Rendering Shader
// Renders 1px lines with day/night tinting
// Part of Pass 2 (Geometry) in Zero's render architecture
//
// Depth tested against globe, atmosphere applied in post-process
// TODO: Label attachment points - store midpoints of contour segments
//       for text placement in future label pass

struct Uniforms {
  viewProj: mat4x4<f32>,
  eyePosition: vec3<f32>,
  _pad0: f32,
  sunDirection: vec3<f32>,
  opacity: f32,
  isStandard: u32,  // 1 if this is the 1012 hPa standard pressure
  _pad1: vec3<f32>,
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
fn fragmentMain(in: VertexOutput) -> FragmentOutput {
  // Day/night tinting
  let surfaceNormal = normalize(in.worldPos);
  let sunDot = dot(surfaceNormal, uniforms.sunDirection);
  let dayFactor = smoothstep(-0.1, 0.2, sunDot);

  let dayColor = vec3<f32>(0.85, 0.85, 0.85);
  let nightColor = vec3<f32>(0.35, 0.35, 0.4);
  var color = mix(nightColor, dayColor, dayFactor);

  // Highlight standard pressure (1012 hPa)
  var alpha = uniforms.opacity;
  if (uniforms.isStandard == 1u) {
    color = mix(color, vec3<f32>(1.0, 1.0, 0.9), 0.3);  // Slight yellow tint
    alpha = min(alpha * 1.2, 1.0);  // Slightly more opaque
  }

  // Compute linear depth matching globe shader
  // Globe: depth = hit.t / (cameraDistance * 2.0)
  let hitT = length(in.worldPos - uniforms.eyePosition);
  let cameraDistance = length(uniforms.eyePosition);
  let linearDepth = clamp(hitT / (cameraDistance * 2.0), 0.0, 1.0);

  return FragmentOutput(vec4<f32>(color, alpha), linearDepth);
}
