/**
 * Camera keyframe model for animated capture
 *
 * Defines keyframe type, creation, interpolation, and KeyframeManager.
 * 2 keyframes: slerp (great-circle arc).
 * 3+ keyframes: Catmull-Rom spline in Cartesian 3D.
 */

import m from 'mithril';
import { signal, type Signal } from '@preact/signals-core';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export interface CameraKeyframe {
  id: number;
  time: number;    // ms since epoch
  lat: number;     // globe latitude (degrees)
  lon: number;     // globe longitude (degrees)
  distance: number; // camera distance from globe center
  pinned: boolean;  // pinned keyframes cannot be deleted
}

export interface InterpolatedCamera {
  lat: number;
  lon: number;
  distance: number;
}

/** Minimal camera interface — avoids importing full AuroraService */
interface CameraProvider {
  getCamera(): { getState(): { lat: number; lon: number; distance: number } };
  setCameraPosition(lat: number, lon: number, distance: number): void;
}

/** Minimal time interface — avoids importing full StateService */
interface TimeController {
  setTime(d: Date): void;
}

let nextId = 1;

export function createKeyframe(
  time: number,
  camera: { lat: number; lon: number; distance: number },
  pinned: boolean,
): CameraKeyframe {
  return {
    id: nextId++,
    time,
    lat: camera.lat,
    lon: camera.lon,
    distance: camera.distance,
    pinned,
  };
}

// ── Coordinate conversion ─────────────────────────────────────────

function latLonToCartesian(lat: number, lon: number): [number, number, number] {
  const latR = lat * DEG2RAD;
  const lonR = lon * DEG2RAD;
  return [
    Math.cos(latR) * Math.cos(lonR),
    Math.cos(latR) * Math.sin(lonR),
    Math.sin(latR),
  ];
}

function cartesianToLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  const len = Math.sqrt(x * x + y * y + z * z);
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, z / len))) * RAD2DEG,
    lon: Math.atan2(y, x) * RAD2DEG,
  };
}

// ── Slerp (2 keyframes) ──────────────────────────────────────────

function slerpPosition(kf0: CameraKeyframe, kf1: CameraKeyframe, t: number): InterpolatedCamera {
  const [ax, ay, az] = latLonToCartesian(kf0.lat, kf0.lon);
  const [bx, by, bz] = latLonToCartesian(kf1.lat, kf1.lon);

  // Dot product for angle between
  let dot = ax * bx + ay * by + az * bz;
  dot = Math.max(-1, Math.min(1, dot));
  const omega = Math.acos(dot);

  let rx: number, ry: number, rz: number;
  if (omega < 1e-6) {
    // Nearly identical — lerp
    rx = ax + (bx - ax) * t;
    ry = ay + (by - ay) * t;
    rz = az + (bz - az) * t;
  } else {
    const sinOmega = Math.sin(omega);
    const s0 = Math.sin((1 - t) * omega) / sinOmega;
    const s1 = Math.sin(t * omega) / sinOmega;
    rx = s0 * ax + s1 * bx;
    ry = s0 * ay + s1 * by;
    rz = s0 * az + s1 * bz;
  }

  const { lat, lon } = cartesianToLatLon(rx, ry, rz);
  const distance = kf0.distance + (kf1.distance - kf0.distance) * t;
  return { lat, lon, distance };
}

// ── Catmull-Rom (3+ keyframes) ───────────────────────────────────

/** 1D Catmull-Rom spline value */
function catmullRom1D(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
  );
}

function catmullRomPosition(keyframes: CameraKeyframe[], timeMs: number): InterpolatedCamera {
  const n = keyframes.length;

  // Clamp to range
  if (timeMs <= keyframes[0]!.time) {
    const kf = keyframes[0]!;
    return { lat: kf.lat, lon: kf.lon, distance: kf.distance };
  }
  if (timeMs >= keyframes[n - 1]!.time) {
    const kf = keyframes[n - 1]!;
    return { lat: kf.lat, lon: kf.lon, distance: kf.distance };
  }

  // Find segment
  let seg = 0;
  for (let i = 0; i < n - 1; i++) {
    if (timeMs >= keyframes[i]!.time && timeMs < keyframes[i + 1]!.time) {
      seg = i;
      break;
    }
  }

  // Local t within segment
  const t0 = keyframes[seg]!.time;
  const t1 = keyframes[seg + 1]!.time;
  const t = t1 === t0 ? 0 : (timeMs - t0) / (t1 - t0);

  // 4 control points (duplicate endpoints for first/last)
  const i0 = Math.max(0, seg - 1);
  const i1 = seg;
  const i2 = seg + 1;
  const i3 = Math.min(n - 1, seg + 2);

  const p0 = latLonToCartesian(keyframes[i0]!.lat, keyframes[i0]!.lon);
  const p1 = latLonToCartesian(keyframes[i1]!.lat, keyframes[i1]!.lon);
  const p2 = latLonToCartesian(keyframes[i2]!.lat, keyframes[i2]!.lon);
  const p3 = latLonToCartesian(keyframes[i3]!.lat, keyframes[i3]!.lon);

  // Catmull-Rom per component
  const rx = catmullRom1D(p0[0], p1[0], p2[0], p3[0], t);
  const ry = catmullRom1D(p0[1], p1[1], p2[1], p3[1], t);
  const rz = catmullRom1D(p0[2], p1[2], p2[2], p3[2], t);

  // Normalize back to unit sphere
  const { lat, lon } = cartesianToLatLon(rx, ry, rz);

  // Distance: 1D Catmull-Rom
  const distance = catmullRom1D(
    keyframes[i0]!.distance, keyframes[i1]!.distance,
    keyframes[i2]!.distance, keyframes[i3]!.distance, t
  );

  return { lat, lon, distance };
}

// ── Public interpolation dispatch ────────────────────────────────

export function interpolateCamera(keyframes: CameraKeyframe[], timeMs: number): InterpolatedCamera {
  if (keyframes.length === 0) {
    return { lat: 0, lon: 0, distance: 3 };
  }
  if (keyframes.length === 1) {
    const kf = keyframes[0]!;
    return { lat: kf.lat, lon: kf.lon, distance: kf.distance };
  }
  if (keyframes.length === 2) {
    const range = keyframes[1]!.time - keyframes[0]!.time;
    const t = range > 0 ? Math.max(0, Math.min(1, (timeMs - keyframes[0]!.time) / range)) : 0;
    return slerpPosition(keyframes[0]!, keyframes[1]!, t);
  }
  return catmullRomPosition(keyframes, timeMs);
}

// ── KeyframeManager ──────────────────────────────────────────────

export class KeyframeManager {
  readonly keyframes: Signal<CameraKeyframe[]> = signal([]);
  readonly activeKeyframeId: Signal<number | null> = signal(null);
  dataWindowStart = 0;
  dataWindowEnd = 0;

  private static readonly MAX = 10;

  constructor(
    private readonly cam: CameraProvider,
    private readonly time: TimeController,
  ) {}

  /** Create pinned start/end keyframes from data window bounds */
  initFromWindow(startMs: number, endMs: number): void {
    this.dataWindowStart = startMs;
    this.dataWindowEnd = endMs;
    const state = this.cam.getCamera().getState();
    this.keyframes.value = [
      createKeyframe(startMs, state, true),
      createKeyframe(endMs, state, true),
    ];
    this.activeKeyframeId.value = null;
  }

  /** Clear all keyframes and reset window */
  reset(): void {
    this.keyframes.value = [];
    this.activeKeyframeId.value = null;
    this.dataWindowStart = 0;
    this.dataWindowEnd = 0;
  }

  add(timeMs: number): void {
    const kfs = this.keyframes.value;
    if (kfs.length >= KeyframeManager.MAX) return;
    const state = this.cam.getCamera().getState();
    const kf = createKeyframe(timeMs, state, false);
    this.keyframes.value = [...kfs, kf].sort((a, b) => a.time - b.time);
    this.activeKeyframeId.value = kf.id;
    m.redraw();
  }

  activate(id: number): void {
    const kf = this.keyframes.value.find(k => k.id === id);
    if (!kf) return;
    this.activeKeyframeId.value = id;
    this.time.setTime(new Date(kf.time));
    this.cam.setCameraPosition(kf.lat, kf.lon, kf.distance);
    m.redraw();
  }

  deactivate(): void {
    this.activeKeyframeId.value = null;
    m.redraw();
  }

  toggle(id: number): void {
    if (this.activeKeyframeId.value === id) {
      this.deactivate();
    } else {
      this.activate(id);
    }
  }

  move(id: number, newTimeMs: number): void {
    const kfs = this.keyframes.value;
    const idx = kfs.findIndex(k => k.id === id);
    if (idx < 0) return;
    const prevTime = idx > 0 ? kfs[idx - 1]!.time : this.dataWindowStart;
    const nextTime = idx < kfs.length - 1 ? kfs[idx + 1]!.time : this.dataWindowEnd;
    const clamped = Math.max(prevTime, Math.min(nextTime, newTimeMs));
    this.keyframes.value = kfs.map(k => k.id === id ? { ...k, time: clamped } : k);
    if (this.activeKeyframeId.value === id) {
      this.time.setTime(new Date(clamped));
    }
    m.redraw();
  }

  deleteActive(): void {
    const activeId = this.activeKeyframeId.value;
    if (activeId === null) return;
    const kf = this.keyframes.value.find(k => k.id === activeId);
    if (!kf || kf.pinned) return;
    this.keyframes.value = this.keyframes.value.filter(k => k.id !== activeId);
    this.activeKeyframeId.value = null;
    m.redraw();
  }

  updateActiveCamera(): void {
    const activeId = this.activeKeyframeId.value;
    if (activeId === null) return;
    const state = this.cam.getCamera().getState();
    this.keyframes.value = this.keyframes.value.map(k =>
      k.id === activeId ? { ...k, lat: state.lat, lon: state.lon, distance: state.distance } : k
    );
  }
}
