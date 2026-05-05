/**
 * Fibonacci Sphere - Uniform point distribution on a sphere
 *
 * Generates evenly distributed points on a unit sphere using the
 * Fibonacci lattice algorithm. Perfect for wind particle seed positions.
 *
 * Algorithm:
 * - Golden angle: 2π / φ² ≈ 2.399963
 * - Latitude: arcsin(1 - 2i/N) for i = 0..N-1
 * - Longitude: golden angle × i (mod 2π)
 *
 * Returns vec4 positions (x, y, z, 0) ready for GPU upload.
 */

const PHI = (1 + Math.sqrt(5)) / 2; // Golden ratio
const GOLDEN_ANGLE = 2 * Math.PI / (PHI * PHI);

/**
 * Generate uniformly distributed points on a unit sphere
 * @param count Number of points (8192, 16384, 32768 recommended)
 * @returns Float32Array of vec4 positions (x, y, z, 0)
 */
export function generateFibonacciSphere(count: number): Float32Array {
  const positions = new Float32Array(count * 4); // vec4 per point

  for (let i = 0; i < count; i++) {
    // Latitude: map i/N to [-1, 1], then to angle
    const y = 1 - (2 * i) / (count - 1);
    const radius = Math.sqrt(1 - y * y); // Circle radius at this latitude

    // Longitude: golden angle spiral
    const theta = GOLDEN_ANGLE * i;

    // Cartesian coordinates
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;

    // Store as vec4 (w=0 for position vector)
    const offset = i * 4;
    positions[offset + 0] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;
    positions[offset + 3] = 0;
  }

  return positions;
}
