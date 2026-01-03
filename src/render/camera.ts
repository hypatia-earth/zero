/**
 * Camera - Orbital camera for globe view
 */

export interface CameraState {
  lat: number;
  lon: number;
  distance: number;
}

export interface CameraConfig {
  fov: number;   // degrees
  near: number;
  far: number;
}

export class Camera {
  lat = 0;
  lon = 0;
  distance = 3;

  private viewMatrix = new Float32Array(16);
  private projMatrix = new Float32Array(16);
  private viewProjMatrix = new Float32Array(16);
  private viewProjInverse = new Float32Array(16);
  private aspect = 1;
  private fov: number;   // radians
  private near: number;
  private far: number;

  constructor(state?: CameraState, config?: CameraConfig) {
    // Apply config (defaults if not provided)
    this.fov = (config?.fov ?? 75) * Math.PI / 180;
    this.near = config?.near ?? 0.1;
    this.far = config?.far ?? 100;

    if (state) {
      this.lat = state.lat;
      this.lon = state.lon;
      this.distance = state.distance;
    }
    this.updateMatrices();
  }

  /** Get tan(fov/2) for shader ray generation */
  getTanFov(): number {
    return Math.tan(this.fov / 2);
  }

  setAspect(width: number, height: number): void {
    this.aspect = width / height;
    this.updateMatrices();
  }

  setPosition(lat: number, lon: number, distance: number): void {
    this.lat = lat;
    this.lon = lon;
    this.distance = distance;
    this.updateMatrices();
  }

  getState(): CameraState {
    return { lat: this.lat, lon: this.lon, distance: this.distance };
  }

  getEyePosition(): Float32Array {
    const latRad = this.lat * Math.PI / 180;
    const lonRad = this.lon * Math.PI / 180;
    return new Float32Array([
      this.distance * Math.cos(latRad) * Math.sin(lonRad),
      this.distance * Math.sin(latRad),
      this.distance * Math.cos(latRad) * Math.cos(lonRad),
    ]);
  }

  getViewProjInverse(): Float32Array {
    this.updateMatrices();
    return this.viewProjInverse;
  }

  getViewProj(): Float32Array {
    this.updateMatrices();
    return this.viewProjMatrix;
  }

  /**
   * Convert screen coordinates to globe lat/lon
   * Returns null if the point doesn't hit the globe
   */
  screenToGlobe(clientX: number, clientY: number, canvasWidth: number, canvasHeight: number): { lat: number; lon: number } | null {
    this.updateMatrices();

    // Convert to NDC (-1 to 1)
    const ndcX = (clientX / canvasWidth) * 2 - 1;
    const ndcY = 1 - (clientY / canvasHeight) * 2;

    // Unproject near and far points using viewProjInverse
    const inv = this.viewProjInverse;

    // Near point (z=0 in NDC for WebGPU)
    const nearW = inv[3]! * ndcX + inv[7]! * ndcY + inv[11]! * 0 + inv[15]!;
    const nearX = (inv[0]! * ndcX + inv[4]! * ndcY + inv[8]! * 0 + inv[12]!) / nearW;
    const nearY = (inv[1]! * ndcX + inv[5]! * ndcY + inv[9]! * 0 + inv[13]!) / nearW;
    const nearZ = (inv[2]! * ndcX + inv[6]! * ndcY + inv[10]! * 0 + inv[14]!) / nearW;

    // Far point (z=1 in NDC for WebGPU)
    const farW = inv[3]! * ndcX + inv[7]! * ndcY + inv[11]! * 1 + inv[15]!;
    const farX = (inv[0]! * ndcX + inv[4]! * ndcY + inv[8]! * 1 + inv[12]!) / farW;
    const farY = (inv[1]! * ndcX + inv[5]! * ndcY + inv[9]! * 1 + inv[13]!) / farW;
    const farZ = (inv[2]! * ndcX + inv[6]! * ndcY + inv[10]! * 1 + inv[14]!) / farW;

    // Ray direction
    const dx = farX - nearX;
    const dy = farY - nearY;
    const dz = farZ - nearZ;

    // Ray origin (camera position)
    const eye = this.getEyePosition();
    const ox = eye[0]!, oy = eye[1]!, oz = eye[2]!;

    // Ray-sphere intersection (sphere at origin, radius 1)
    const a = dx * dx + dy * dy + dz * dz;
    const b = 2 * (ox * dx + oy * dy + oz * dz);
    const c = ox * ox + oy * oy + oz * oz - 1;

    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;

    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0) return null;

    // Hit point on sphere
    const px = ox + t * dx;
    const py = oy + t * dy;
    const pz = oz + t * dz;

    // Convert to lat/lon (Y-up coordinate system)
    const lat = Math.asin(Math.max(-1, Math.min(1, py))) * 180 / Math.PI;
    const lon = Math.atan2(px, pz) * 180 / Math.PI;

    return { lat, lon };
  }

  private updateMatrices(): void {
    const eye = this.getEyePosition();
    this.lookAt(this.viewMatrix, eye, [0, 0, 0], [0, 1, 0]);
    this.perspective(this.projMatrix, this.fov, this.aspect, this.near, this.far);
    this.multiply(this.viewProjMatrix, this.projMatrix, this.viewMatrix);

    // Compute inverses separately (more stable than inverting combined matrix)
    const viewInverse = new Float32Array(16);
    const projInverse = new Float32Array(16);
    this.invertView(viewInverse, this.viewMatrix, eye);
    this.invertPerspective(projInverse, this.fov, this.aspect, this.near, this.far);
    this.multiply(this.viewProjInverse, viewInverse, projInverse);
  }

  private invertView(out: Float32Array, view: Float32Array, eye: Float32Array): void {
    // View inverse: transpose rotation, transform eye position
    // R^-1 = R^T for orthonormal, t^-1 = -R^T * t but we have eye position directly
    out[0] = view[0]!;  out[1] = view[4]!;  out[2] = view[8]!;   out[3] = 0;
    out[4] = view[1]!;  out[5] = view[5]!;  out[6] = view[9]!;   out[7] = 0;
    out[8] = view[2]!;  out[9] = view[6]!;  out[10] = view[10]!; out[11] = 0;
    out[12] = eye[0]!;  out[13] = eye[1]!;  out[14] = eye[2]!;   out[15] = 1;
  }

  private invertPerspective(out: Float32Array, fov: number, aspect: number, near: number, far: number): void {
    // Inverse of WebGPU perspective matrix (0-1 depth range)
    const f = Math.tan(fov / 2);
    out[0] = f * aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 0; out[11] = (near - far) / (far * near);
    out[12] = 0; out[13] = 0; out[14] = -1; out[15] = 1 / near;
  }

  private lookAt(out: Float32Array, eye: Float32Array, center: number[], up: number[]): void {
    // Forward vector (from target to eye)
    let fx = eye[0]! - center[0]!, fy = eye[1]! - center[1]!, fz = eye[2]! - center[2]!;
    let len = 1 / Math.sqrt(fx * fx + fy * fy + fz * fz);
    fx *= len; fy *= len; fz *= len;

    // Right vector = up × forward
    let rx = up[1]! * fz - up[2]! * fy;
    let ry = up[2]! * fx - up[0]! * fz;
    let rz = up[0]! * fy - up[1]! * fx;
    len = Math.sqrt(rx * rx + ry * ry + rz * rz);
    rx /= len; ry /= len; rz /= len;

    // Recompute up = forward × right
    const ux = fy * rz - fz * ry;
    const uy = fz * rx - fx * rz;
    const uz = fx * ry - fy * rx;

    // Column-major order for WebGPU
    out[0] = rx;  out[1] = ux;  out[2] = fx;  out[3] = 0;
    out[4] = ry;  out[5] = uy;  out[6] = fy;  out[7] = 0;
    out[8] = rz;  out[9] = uz;  out[10] = fz; out[11] = 0;
    out[12] = -(rx * eye[0]! + ry * eye[1]! + rz * eye[2]!);
    out[13] = -(ux * eye[0]! + uy * eye[1]! + uz * eye[2]!);
    out[14] = -(fx * eye[0]! + fy * eye[1]! + fz * eye[2]!);
    out[15] = 1;
  }

  private perspective(out: Float32Array, fov: number, aspect: number, near: number, far: number): void {
    // WebGPU uses 0-1 depth range (not -1 to 1 like OpenGL)
    const f = 1 / Math.tan(fov / 2);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = far / (near - far); out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = (far * near) / (near - far); out[15] = 0;
  }

  private multiply(out: Float32Array, a: Float32Array, b: Float32Array): void {
    // Column-major matrix multiplication: C = A * B
    // Element at [row][col] stored at index col*4+row
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += a[k * 4 + row]! * b[col * 4 + k]!;
        }
        out[col * 4 + row] = sum;
      }
    }
  }
}
