// Wind Layer Rendering Shader (T3: Surface Curves)
// Renders wind lines traced on sphere surface using Rodrigues rotation
// Part of Pass 2 (Geometry) in Zero's render architecture

struct Uniforms {
  viewProj: mat4x4<f32>,
  eyePosition: vec3<f32>,
  opacity: f32,
  animPhase: f32,      // 0-1 animation phase
  snakeLength: f32,    // fraction of line visible (0-1)
  lineWidth: f32,      // world units (~0.003 = 20km)
  _pad: f32,
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
  // Triangle-list: 6 vertices per segment (2 triangles forming a quad)
  // Vertex pattern: 0,1,2, 2,1,3 for quad [p0+perp, p0-perp, p1+perp, p1-perp]
  let segmentsPerLine = 32u;
  let numSegments = segmentsPerLine - 1u;  // 31 segments from 32 points
  let segmentIdx = vertexIdx / 6u;         // Which segment
  let cornerIdx = vertexIdx % 6u;          // Which vertex in quad (0-5)

  // Map triangle vertices to quad corners: 0,1,2,2,1,3
  var quadCorner: u32;
  switch (cornerIdx) {
    case 0u: { quadCorner = 0u; }  // p0 + perp
    case 1u: { quadCorner = 1u; }  // p0 - perp
    case 2u: { quadCorner = 2u; }  // p1 + perp
    case 3u: { quadCorner = 2u; }  // p1 + perp
    case 4u: { quadCorner = 1u; }  // p0 - perp
    case 5u: { quadCorner = 3u; }  // p1 - perp
    default: { quadCorner = 0u; }
  }

  // Get segment endpoints
  let p0Idx = instanceIdx * segmentsPerLine + segmentIdx;
  let p1Idx = p0Idx + 1u;
  let p0 = linePoints[p0Idx];
  let p1 = linePoints[p1Idx];

  // Calculate camera-facing perpendicular for quad expansion
  let toCamera = normalize(uniforms.eyePosition - p0.position);
  let lineDir = normalize(p1.position - p0.position);
  let perp = normalize(cross(lineDir, toCamera));

  // Scale width by distance for constant screen-pixel width
  let camDist = length(uniforms.eyePosition - p0.position);
  let scaledWidth = uniforms.lineWidth * camDist;

  // Expand to quad corner
  var worldPos: vec3<f32>;
  switch (quadCorner) {
    case 0u: { worldPos = p0.position + perp * scaledWidth; }
    case 1u: { worldPos = p0.position - perp * scaledWidth; }
    case 2u: { worldPos = p1.position + perp * scaledWidth; }
    case 3u: { worldPos = p1.position - perp * scaledWidth; }
    default: { worldPos = p0.position; }
  }

  // Snake animation: phase offset per line
  let phaseOffset = fract(f32(instanceIdx) * 0.618033988749);
  let linePhase = fract(uniforms.animPhase + phaseOffset);
  let headPos = linePhase;
  let snakeLen = uniforms.snakeLength;
  let segPos = f32(segmentIdx) / f32(numSegments);

  // Distance from segment to snake head (wrapping)
  var dist = headPos - segPos;
  if (dist < 0.0) { dist += 1.0; }

  // Alpha: 1.0 at head, fading to 0 at tail
  var alpha = 0.0;
  if (dist < snakeLen) {
    alpha = 1.0 - (dist / snakeLen);
  }

  // Average speed for segment
  let speed = (p0.speed + p1.speed) * 0.5;

  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  out.worldPos = worldPos;
  out.speed = speed;
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
