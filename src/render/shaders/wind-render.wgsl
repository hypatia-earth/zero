// Wind Layer Rendering Shader (T3: Surface Curves)
// Renders wind lines traced on sphere surface using Rodrigues rotation
// Part of Pass 2 (Geometry) in Zero's render architecture

struct Uniforms {
  viewProj: mat4x4<f32>,
  eyePosition: vec3<f32>,
  opacity: f32,
  animPhase: f32,      // 0-1 animation phase
  snakeLength: f32,    // fraction of line visible (0-1)
  _pad: vec2<f32>,
}

struct LinePoint {
  position: vec3<f32>,
  speed: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) speed: f32,
  @location(2) alpha: f32,  // Snake fade alpha
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
  let segmentsPerLine = 32u;
  let numSegments = segmentsPerLine - 1u;  // 31 segments from 32 points
  let segmentIdx = vertexIdx / 2u;
  let isEnd = vertexIdx % 2u;
  let pointInLine = segmentIdx + isEnd;

  let pointIdx = instanceIdx * segmentsPerLine + pointInLine;
  let point = linePoints[pointIdx];

  // Snake animation: each line has phase offset based on instance
  // Golden ratio offset for good distribution
  let phaseOffset = fract(f32(instanceIdx) * 0.618033988749);
  let linePhase = fract(uniforms.animPhase + phaseOffset);

  // Snake window: head position along line (0-1)
  let headPos = linePhase;
  let snakeLen = uniforms.snakeLength;

  // Position of this segment along line (0-1)
  let segPos = f32(segmentIdx) / f32(numSegments);

  // Distance from segment to snake head (wrapping)
  var dist = headPos - segPos;
  if (dist < 0.0) { dist += 1.0; }

  // Alpha: 1.0 at head, fading to 0 at tail
  var alpha = 0.0;
  if (dist < snakeLen) {
    // Fade from head (1.0) to tail (0.0)
    alpha = 1.0 - (dist / snakeLen);
  }

  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4<f32>(point.position, 1.0);
  out.worldPos = point.position;
  out.speed = point.speed;
  out.alpha = alpha;
  return out;
}

// Speed-to-color mapping (dark red → bright red)
fn speedToColor(speed: f32) -> vec3<f32> {
  // Normalize speed: 0-40 m/s range (hurricane force ~33 m/s)
  let t = clamp(speed / 40.0, 0.0, 1.0);

  // Shades of red: dark (0.3, 0.05, 0.05) → bright (1.0, 0.3, 0.2)
  return vec3<f32>(
    0.3 + t * 0.7,   // R: 0.3 → 1.0
    0.05 + t * 0.25, // G: 0.05 → 0.3
    0.05 + t * 0.15  // B: 0.05 → 0.2
  );
}

@fragment
fn fragmentMain(in: VertexOutput) -> FragmentOutput {
  // Discard invisible segments
  if (in.alpha < 0.01) {
    discard;
  }

  // Linear depth with offset to render slightly in front of globe surface
  let hitT = length(in.worldPos - uniforms.eyePosition);
  let cameraDistance = length(uniforms.eyePosition);
  let linearDepth = clamp(hitT / (cameraDistance * 2.0), 0.0, 1.0);
  let depthOffset = 0.0001;

  // Color based on wind speed, alpha from snake animation
  let color = speedToColor(in.speed);
  let finalAlpha = uniforms.opacity * in.alpha;

  return FragmentOutput(vec4<f32>(color, finalAlpha), linearDepth - depthOffset);
}
