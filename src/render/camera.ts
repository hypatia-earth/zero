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
  private fov = Math.PI / 4;

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
    this.perspective(this.projMatrix, this.fov, this.aspect, 0.1, 100);
    this.multiply(this.viewProjMatrix, this.projMatrix, this.viewMatrix);
    this.invert(this.viewProjInverse, this.viewProjMatrix);
  }

  private lookAt(out: Float32Array, eye: Float32Array, center: number[], up: number[]): void {
    const zx = eye[0]! - center[0]!, zy = eye[1]! - center[1]!, zz = eye[2]! - center[2]!;
    let len = 1 / Math.sqrt(zx * zx + zy * zy + zz * zz);
    const z0 = zx * len, z1 = zy * len, z2 = zz * len;
    const x0 = up[1]! * z2 - up[2]! * z1, x1 = up[2]! * z0 - up[0]! * z2, x2 = up[0]! * z1 - up[1]! * z0;
    len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
    const xx = x0 / len, xy = x1 / len, xz = x2 / len;
    const yx = z1 * xz - z2 * xy, yy = z2 * xx - z0 * xz, yz = z0 * xy - z1 * xx;
    out[0] = xx; out[1] = yx; out[2] = z0; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = z1; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = z2; out[11] = 0;
    out[12] = -(xx * eye[0]! + xy * eye[1]! + xz * eye[2]!);
    out[13] = -(yx * eye[0]! + yy * eye[1]! + yz * eye[2]!);
    out[14] = -(z0 * eye[0]! + z1 * eye[1]! + z2 * eye[2]!);
    out[15] = 1;
  }

  private perspective(out: Float32Array, fov: number, aspect: number, near: number, far: number): void {
    const f = 1 / Math.tan(fov / 2);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) / (near - far); out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = (2 * far * near) / (near - far); out[15] = 0;
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
