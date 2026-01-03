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
  randomSeed: f32,     // random offset for phase distribution
  showBackface: f32,   // 1.0 = show full geometry (no texture layers visible)
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

// Pseudo-random hash for per-line phase offset
fn hash(n: u32) -> f32 {
  var x = n;
  x = ((x >> 16u) ^ x) * 0x45d9f3bu;
  x = ((x >> 16u) ^ x) * 0x45d9f3bu;
  x = (x >> 16u) ^ x;
  return f32(x) / 4294967295.0;
}

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

  // Snake animation: pseudo-random phase offset per line
  let phaseOffset = hash(instanceIdx + u32(uniforms.randomSeed * 1000000.0));
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

// Speed-to-color mapping based on Beaufort scale hazard thresholds
// White (0-17 m/s) → gradient to red (17-26 m/s) → full red (26+ m/s)
// Alpha ramps from 0% at 0 m/s to 100% at 17 m/s
fn speedToColor(speed: f32) -> vec4<f32> {
  let safeThreshold = 17.0;   // Beaufort 8: gale, walking difficult
  let dangerThreshold = 26.0; // Beaufort 10: storm, trees uprooted

  // Alpha: 60% at 0 m/s → 100% at 17 m/s
  let alpha = 0.6 + 0.4 * clamp(speed / safeThreshold, 0.0, 1.0);

  if (speed < safeThreshold) {
    // Safe: white with speed-based alpha
    return vec4<f32>(1.0, 1.0, 1.0, alpha);
  } else if (speed < dangerThreshold) {
    // Hazardous: white → red gradient
    let t = (speed - safeThreshold) / (dangerThreshold - safeThreshold);
    return vec4<f32>(1.0, 1.0 - t * 0.8, 1.0 - t * 0.9, 1.0);
  } else {
    // Dangerous: full red
    return vec4<f32>(1.0, 0.2, 0.1, 1.0);
  }
}

@fragment
fn fragmentMain(in: VertexOutput) -> FragmentOutput {
  // Discard invisible segments
  if (in.alpha < 0.01) {
    discard;
  }

  // Perspective-correct backface culling with animated limb
  // showBackface: 0.0 = full culling, 1.0 = show everything
  let camDist = length(uniforms.eyePosition);
  let threshold = 1.0 + uniforms.lineWidth * camDist * camDist * 18.0;
  let sphereTest = normalize(in.worldPos);
  let sphereDot = dot(sphereTest, uniforms.eyePosition);

  // Animated limb: expand visible region as showBackface increases
  // At showBackface=0: only front hemisphere visible (sphereDot >= threshold)
  // At showBackface=1: entire sphere visible (sphereDot >= -camDist)
  let backThreshold = -camDist - threshold;
  let limbThreshold = mix(threshold, backThreshold, uniforms.showBackface);
  if (sphereDot < limbThreshold) {
    discard;
  }

  // Linear depth with offset to render slightly in front of globe surface
  let hitT = length(in.worldPos - uniforms.eyePosition);
  let cameraDistance = length(uniforms.eyePosition);
  let linearDepth = clamp(hitT / (cameraDistance * 2.0), 0.0, 1.0);
  let depthOffset = 0.0001;

  // Color and speed-based alpha from palette, combined with snake animation alpha
  let colorAlpha = speedToColor(in.speed);
  let finalAlpha = uniforms.opacity * in.alpha * colorAlpha.a;

  return FragmentOutput(vec4<f32>(colorAlpha.rgb, finalAlpha), linearDepth - depthOffset);
}
