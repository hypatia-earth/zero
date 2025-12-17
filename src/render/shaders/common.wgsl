// Common constants and types shared across all shader modules

const COMMON_PI: f32 = 3.14159265359;
const COMMON_TAU: f32 = 6.28318530718;
const EARTH_RADIUS: f32 = 1.0;
const BG_COLOR: vec4f = vec4f(0.086, 0.086, 0.086, 1.0);

struct RayHit {
  valid: bool,
  point: vec3f,
  t: f32,
}

fn raySphereIntersect(rayOrigin: vec3f, rayDir: vec3f, radius: f32) -> RayHit {
  let oc = rayOrigin;
  let a = dot(rayDir, rayDir);
  let b = 2.0 * dot(oc, rayDir);
  let c = dot(oc, oc) - radius * radius;
  let discriminant = b * b - 4.0 * a * c;

  if (discriminant < 0.0) {
    return RayHit(false, vec3f(0.0), 0.0);
  }

  let t = (-b - sqrt(discriminant)) / (2.0 * a);
  if (t < 0.0) {
    return RayHit(false, vec3f(0.0), 0.0);
  }

  let point = rayOrigin + t * rayDir;
  return RayHit(true, point, t);
}

// Far intersection (back of sphere) - for rendering back-side grid
fn raySphereIntersectFar(rayOrigin: vec3f, rayDir: vec3f, radius: f32) -> RayHit {
  let oc = rayOrigin;
  let a = dot(rayDir, rayDir);
  let b = 2.0 * dot(oc, rayDir);
  let c = dot(oc, oc) - radius * radius;
  let discriminant = b * b - 4.0 * a * c;

  if (discriminant < 0.0) {
    return RayHit(false, vec3f(0.0), 0.0);
  }

  let t = (-b + sqrt(discriminant)) / (2.0 * a);  // + for far hit
  if (t < 0.0) {
    return RayHit(false, vec3f(0.0), 0.0);
  }

  let point = rayOrigin + t * rayDir;
  return RayHit(true, point, t);
}
