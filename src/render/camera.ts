/**
 * Camera - Orbital camera for globe view
 */

export interface CameraState {
  lat: number;
  lon: number;
  distance: number;
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
  private fov = 75 * Math.PI / 180; // 75 degrees

  constructor(state?: CameraState) {
    if (state) {
      this.lat = state.lat;
      this.lon = state.lon;
      this.distance = state.distance;
    }
    this.updateMatrices();
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

  private updateMatrices(): void {
    const eye = this.getEyePosition();
    this.lookAt(this.viewMatrix, eye, [0, 0, 0], [0, 1, 0]);
    this.perspective(this.projMatrix, this.fov, this.aspect, 0.1, 1000);
    this.multiply(this.viewProjMatrix, this.projMatrix, this.viewMatrix);

    // Compute inverses separately (more stable than inverting combined matrix)
    const viewInverse = new Float32Array(16);
    const projInverse = new Float32Array(16);
    this.invertView(viewInverse, this.viewMatrix, eye);
    this.invertPerspective(projInverse, this.fov, this.aspect, 0.1, 1000);
    this.multiply(this.viewProjInverse, viewInverse, projInverse);
  }

  private invertView(out: Float32Array, view: Float32Array, eye: Float32Array): void {
    // View inverse: transpose rotation, transform eye position
    // R^-1 = R^T for orthonormal, t^-1 = -R^T * t but we have eye position directly
    out[0] = view[0];  out[1] = view[4];  out[2] = view[8];   out[3] = 0;
    out[4] = view[1];  out[5] = view[5];  out[6] = view[9];   out[7] = 0;
    out[8] = view[2];  out[9] = view[6];  out[10] = view[10]; out[11] = 0;
    out[12] = eye[0]!; out[13] = eye[1]!; out[14] = eye[2]!;  out[15] = 1;
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
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        out[i * 4 + j] = 0;
        for (let k = 0; k < 4; k++) {
          out[i * 4 + j]! += a[i * 4 + k]! * b[k * 4 + j]!;
        }
      }
    }
  }

  private invert(out: Float32Array, m: Float32Array): void {
    const m00 = m[0]!, m01 = m[1]!, m02 = m[2]!, m03 = m[3]!;
    const m10 = m[4]!, m11 = m[5]!, m12 = m[6]!, m13 = m[7]!;
    const m20 = m[8]!, m21 = m[9]!, m22 = m[10]!, m23 = m[11]!;
    const m30 = m[12]!, m31 = m[13]!, m32 = m[14]!, m33 = m[15]!;
    const b00 = m00 * m11 - m01 * m10, b01 = m00 * m12 - m02 * m10;
    const b02 = m00 * m13 - m03 * m10, b03 = m01 * m12 - m02 * m11;
    const b04 = m01 * m13 - m03 * m11, b05 = m02 * m13 - m03 * m12;
    const b06 = m20 * m31 - m21 * m30, b07 = m20 * m32 - m22 * m30;
    const b08 = m20 * m33 - m23 * m30, b09 = m21 * m32 - m22 * m31;
    const b10 = m21 * m33 - m23 * m31, b11 = m22 * m33 - m23 * m32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return;
    det = 1 / det;
    out[0] = (m11 * b11 - m12 * b10 + m13 * b09) * det;
    out[1] = (m02 * b10 - m01 * b11 - m03 * b09) * det;
    out[2] = (m31 * b05 - m32 * b04 + m33 * b03) * det;
    out[3] = (m22 * b04 - m21 * b05 - m23 * b03) * det;
    out[4] = (m12 * b08 - m10 * b11 - m13 * b07) * det;
    out[5] = (m00 * b11 - m02 * b08 + m03 * b07) * det;
    out[6] = (m32 * b02 - m30 * b05 - m33 * b01) * det;
    out[7] = (m20 * b05 - m22 * b02 + m23 * b01) * det;
    out[8] = (m10 * b10 - m11 * b08 + m13 * b06) * det;
    out[9] = (m01 * b08 - m00 * b10 - m03 * b06) * det;
    out[10] = (m30 * b04 - m31 * b02 + m33 * b00) * det;
    out[11] = (m21 * b02 - m20 * b04 - m23 * b00) * det;
    out[12] = (m11 * b07 - m10 * b09 - m12 * b06) * det;
    out[13] = (m00 * b09 - m01 * b07 + m02 * b06) * det;
    out[14] = (m31 * b01 - m30 * b03 - m32 * b00) * det;
    out[15] = (m20 * b03 - m21 * b01 + m22 * b00) * det;
  }
}
