// Rain/precipitation layer — procedural SDF particle animation
//
// Single param: precipitation_type (WMO code, advected by wind)
// Type selects shape+color, density is uniform from config.

// ─── Hash ───────────────────────────────────────────────────────────────────

fn rainHash1(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn rainHash2(p: vec2f) -> vec2f {
  return vec2f(
    fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453),
    fract(sin(dot(p, vec2f(269.5, 183.3))) * 43758.5453),
  );
}

// ─── SDF (unit radius, < 0 = inside) ───────────────────────────────────────

fn sdfDisk(p: vec2f) -> f32 {
  return length(p) - 1.0;
}

fn sdfDrop(p: vec2f) -> f32 {
  // Round bottom, pointy top: squeeze x progressively above center
  let squeeze = 1.0 + max(p.y, 0.0) * 1.5;
  return length(vec2f(p.x * squeeze / 0.75, p.y)) - 1.0;
}

fn sdfDiamond(p: vec2f) -> f32 {
  let q = abs(p);
  return (q.x + q.y) - 1.0;
}

fn sdfSquare(p: vec2f) -> f32 {
  let d = abs(p);
  return max(d.x, d.y) - 0.8;
}

fn sdfStar6(p: vec2f) -> f32 {
  let angle = atan2(p.y, p.x);
  let r = length(p);
  let petal = abs(cos(angle * 3.0)) * 0.6 + 0.4;
  return r - petal;
}

// ─── Color per WMO code ─────────────────────────────────────────────────────

const RAIN_COLOR_WET = vec3f(0.7, 0.85, 1.0);     // bright blue — liquid
const RAIN_COLOR_FROZEN = vec3f(1.0, 1.0, 1.0);   // white — frozen

fn precipTypeColor(ptype: f32, cellId: vec2f) -> vec3f {
  let code = u32(ptype + 0.5);
  switch code {
    case 1u:       { return RAIN_COLOR_WET; }               // rain
    case 3u, 12u:  { return RAIN_COLOR_FROZEN; }            // freezing rain/drizzle
    case 5u:       { return RAIN_COLOR_FROZEN; }            // snow
    case 6u, 7u:   {                                        // wet snow, sleet — mixed
      return select(RAIN_COLOR_WET, RAIN_COLOR_FROZEN, rainHash1(cellId * 137.0) > 0.5);
    }
    case 8u:       { return RAIN_COLOR_FROZEN; }            // ice pellets
    default:       { return vec3f(1.0, 0.0, 0.0); }        // unknown → red
  }
}

// ─── Blend ──────────────────────────────────────────────────────────────────

fn blendRain(color: vec4f, lat: f32, lon: f32) -> vec4f {
  if (!isLayerDataReady(LAYER_RAIN)) { return color; }
  let opacity = getLayerOpacity(LAYER_RAIN);

  // Fixed grid from default zoom (particles anchored to globe surface)
  let fov = 2.0 * atan(u.tanFov);
  let refRadiusPx = asin(1.0 / 3.2) * u.resolution.y / fov;
  let cellSidePx = 1.0 / sqrt(u.rainDensity);
  let gridSize = max(floor(2.0 * refRadiusPx / cellSidePx), 1.0);
  let latIdx = floor(lat * gridSize / COMMON_PI);
  let latCenter = (latIdx + 0.5) * COMMON_PI / gridSize;
  let lonCells = max(floor(2.0 * gridSize * cos(latCenter)), 1.0);
  let lonIdx = floor(lon * lonCells / COMMON_TAU);
  let cellId = vec2f(lonIdx, latIdx);
  let cellUV = vec2f(
    fract(lon * lonCells / COMMON_TAU),
    fract(lat * gridSize / COMMON_PI),
  );

  // Particle SDF — constrain position so shape fits within cell
  let r = u.rainSizePx / cellSidePx;
  let particlePos = rainHash2(cellId) * (1.0 - 2.0 * r) + r;
  let p = cellUV - particlePos;
  let pn = p / r;

  // Sample ptype at particle center (not per pixel) to avoid O1280 grid clipping
  let cellCenterLat = (latIdx + particlePos.y) * COMMON_PI / gridSize;
  let cellCenterLon = (lonIdx + particlePos.x) * COMMON_TAU / lonCells;
  let ptype = sampleParam_precipitation_type(cellCenterLat, cellCenterLon);
  if (ptype < 0.5) { return color; }

  // Shape by type
  let code = u32(ptype + 0.5);
  var sdf: f32;
  switch code {
    case 3u, 12u:  { sdf = sdfSquare(pn); }                  // freezing rain/drizzle
    case 5u:       { sdf = sdfStar6(pn); }                   // snow
    case 6u, 7u:   {                                          // wet snow, sleet — mixed
      sdf = select(sdfDisk(pn), sdfStar6(pn), rainHash1(cellId * 137.0) > 0.5);
    }
    case 8u:       { sdf = sdfDiamond(pn); }                 // ice pellets
    case 1u:       { sdf = sdfDrop(pn); }                     // rain
    default:       { sdf = sdfDisk(pn); }                    // unknown
  }
  if (sdf > 0.0) { return color; }

  // Fade loop — reduced range so particles never vanish (avoids pop-in flicker on time scrub)
  let phase = fract(u.time / u.rainFadeDuration + rainHash1(cellId));
  let fadeAlpha = 0.5 + 0.5 * (1.0 - phase);

  // DEBUG: encode raw ptype value as brightness for unknown codes
  let typeColor = precipTypeColor(ptype, cellId);
  let alpha = fadeAlpha * opacity;
  return vec4f(mix(color.rgb, typeColor, alpha), color.a);
}
