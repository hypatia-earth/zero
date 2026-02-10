// Contour Line Rendering Shader
// Renders 1px lines with configurable color modes
// Part of Pass 2 (Geometry) in Zero's render architecture
//
// Color modes:
// 0 = solid: all lines same color
// 1 = gradient: blue → white → red based on pressure
// 2 = normal: reference pressure colored, others dimmed
// 3 = debug: hash-based colors for debugging

struct Uniforms {
  viewProj: mat4x4<f32>,
  eyePosition: vec3<f32>,
  _pad0: f32,
  sunDirection: vec3<f32>,
  opacity: f32,

  // Color uniforms
  colorMode: u32,           // 0=solid, 1=gradient, 2=normal, 3=debug
  pressureMin: f32,         // ~96000 Pa (960 hPa)
  pressureMax: f32,         // ~104000 Pa (1040 hPa)
  pressureRef: f32,         // 101200 Pa (1012 hPa)
  color0: vec4<f32>,        // solid: all, gradient: low, normal: ref
  color1: vec4<f32>,        // gradient: ref (1012), normal: other
  color2: vec4<f32>,        // gradient: high
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) pressure: f32,
  @location(2) @interpolate(flat) segmentIdx: u32,
}

struct FragmentOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> vertices: array<vec4<f32>>;

@vertex
fn vertexMain(@builtin(vertex_index) idx: u32) -> VertexOutput {
  let vertex = vertices[idx];

  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4<f32>(vertex.xyz, 1.0);
  out.worldPos = vertex.xyz;
  out.pressure = vertex.w;
  out.segmentIdx = idx / 2u;  // 2 vertices per segment
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> FragmentOutput {
  var color: vec4<f32>;

  let t = clamp(
    (in.pressure - uniforms.pressureMin) / (uniforms.pressureMax - uniforms.pressureMin),
    0.0, 1.0
  );
  let tRef = (uniforms.pressureRef - uniforms.pressureMin) /
             (uniforms.pressureMax - uniforms.pressureMin);

  switch(uniforms.colorMode) {
    case 0u: { // solid
      color = uniforms.color0;
    }
    case 1u: { // gradient: blue → white → red
      if (t < tRef) {
        color = mix(uniforms.color0, uniforms.color1, t / tRef);
      } else {
        color = mix(uniforms.color1, uniforms.color2, (t - tRef) / (1.0 - tRef));
      }
    }
    case 2u: { // normal: ref colored, other dimmed
      let isRef = abs(in.pressure - uniforms.pressureRef) < 100.0;  // within 1 hPa
      color = select(uniforms.color1, uniforms.color0, isRef);
    }
    case 3u: { // debug: color by segment index (4 colors cycling)
      let segMod = in.segmentIdx % 4u;  // cycle through 4 colors
      if (segMod == 0u) {
        color = vec4<f32>(1.0, 0.0, 0.0, 1.0);  // red
      } else if (segMod == 1u) {
        color = vec4<f32>(0.0, 1.0, 0.0, 1.0);  // green
      } else if (segMod == 2u) {
        color = vec4<f32>(0.0, 0.0, 1.0, 1.0);  // blue
      } else {
        color = vec4<f32>(1.0, 1.0, 0.0, 1.0);  // yellow
      }
    }
    default: {
      color = vec4<f32>(1.0);
    }
  }

  color.a *= uniforms.opacity;

  // Compute linear depth matching globe shader
  let hitT = length(in.worldPos - uniforms.eyePosition);
  let cameraDistance = length(uniforms.eyePosition);
  let linearDepth = clamp(hitT / (cameraDistance * 2.0), 0.0, 1.0);

  return FragmentOutput(color, linearDepth);
}
