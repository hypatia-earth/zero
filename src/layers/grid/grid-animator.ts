/**
 * GridAnimator - Manages animated grid LoD transitions
 *
 * Lines are born at 0° and slide to position, reverse for death.
 * LoD level changes based on altitude with hysteresis.
 */

import { defaultConfig } from '../../config/defaults';
import type { GridLodLevel } from '../../config/types';

const DEBUG = false;

// Per-line animation state
interface LineState {
  targetDeg: number;    // final position in degrees
  currentDeg: number;   // animated position
  startDeg: number;     // position when animation started (for dying lines)
  opacity: number;      // 0-1 for fade in/out
  isNew: boolean;       // just born, animating from 0°
  isDying: boolean;     // converging to 0° to die
}

// Constants
const MAX_LINES = 80;  // max lines per axis (72 lon + margin)
const ANIMATION_DURATION = 1000;  // ms per birth/death cycle
export const GRID_BUFFER_SIZE = 1328;  // bytes for GPU buffer (aligned to 16)

// LoD levels from config (includes spacing and pixel thresholds)
const LOD_LEVELS: GridLodLevel[] = defaultConfig.grid.lodLevels;

// Generate line positions for a given spacing
function generateLonLines(spacing: number): number[] {
  const lines: number[] = [];
  for (let deg = 0; deg < 360; deg += spacing) {
    lines.push(deg);
  }
  return lines;
}

function generateLatLines(spacing: number): number[] {
  const lines: number[] = [0];  // Always include equator
  // Add lines north and south from equator
  for (let deg = spacing; deg <= 90; deg += spacing) {
    lines.push(deg);   // North
    lines.push(-deg);  // South
  }
  return lines.sort((a, b) => a - b);
}

export class GridAnimator {
  private lodLevel = 0;
  private lonLines: LineState[] = [];
  private latLines: LineState[] = [];
  private animating = false;
  private animationProgress = 0;

  constructor(initialGlobeRadiusPx: number) {
    // Find correct LoD for starting globe radius
    this.lodLevel = this.getLodForGlobeRadius(initialGlobeRadiusPx);
    this.initializeLines();
  }

  private getLodForGlobeRadius(globeRadiusPx: number): number {
    // Find highest LoD level where globe radius is at or above zoomInPx threshold
    for (let i = LOD_LEVELS.length - 1; i >= 0; i--) {
      if (globeRadiusPx >= LOD_LEVELS[i]!.zoomInPx) {
        return i;
      }
    }
    return 0;
  }

  private initializeLines(): void {
    const level = LOD_LEVELS[this.lodLevel]!;

    // Initialize longitude lines
    this.lonLines = generateLonLines(level.spacing).map(deg => ({
      targetDeg: deg,
      currentDeg: deg,
      startDeg: deg,
      opacity: 1,
      isNew: false,
      isDying: false,
    }));

    // Initialize latitude lines
    this.latLines = generateLatLines(level.spacing).map(deg => ({
      targetDeg: deg,
      currentDeg: deg,
      startDeg: deg,
      opacity: 1,
      isNew: false,
      isDying: false,
    }));
  }

  private checkLodTransition(globeRadiusPx: number): void {
    const targetLevel = this.getLodForGlobeRadius(globeRadiusPx);

    if (targetLevel !== this.lodLevel) {
      DEBUG && console.log(`GridAnimator: LoD ${this.lodLevel} → ${targetLevel} at ${globeRadiusPx}px`);
      this.startTransition(targetLevel);
    }
  }

  private startTransition(newLevel: number): void {
    const targetLevel = LOD_LEVELS[newLevel]!;

    this.lodLevel = newLevel;
    this.animating = true;
    this.animationProgress = 0;

    // Calculate target line positions
    const targetLonPositions = generateLonLines(targetLevel.spacing);
    const targetLatPositions = generateLatLines(targetLevel.spacing);

    // Unified transition: handles both birth and death
    this.transitionLines(this.lonLines, targetLonPositions, true);
    this.transitionLines(this.latLines, targetLatPositions, false);
  }

  /**
   * Transition lines with outward/inward animation
   * - Zoom in: existing lines move outward, new lines born from 0°
   * - Zoom out: lines move inward, lines reaching 0° die
   */
  private transitionLines(
    lines: LineState[],
    targetPositions: number[],
    isLon: boolean
  ): void {
    if (isLon) {
      this.transitionLonLines(lines, targetPositions);
    } else {
      this.transitionLatLines(lines, targetPositions);
    }
  }

  private transitionLonLines(lines: LineState[], targetPositions: number[]): void {
    const result: LineState[] = [];

    // Convert to signed representation (-180 to 180) for easier logic
    const toSigned = (deg: number) => deg > 180 ? deg - 360 : deg;
    const toUnsigned = (deg: number) => deg < 0 ? deg + 360 : deg;

    // Use currentDeg for grouping (where lines actually are now)
    const oldSigned = lines.map(l => ({ line: l, signed: toSigned(l.currentDeg) }));
    const newSigned = targetPositions.map(p => toSigned(p));

    // Handle 0° specially - always stays if in both sets
    const old0 = oldSigned.find(o => o.signed === 0);
    const has0 = newSigned.includes(0);
    if (old0 && has0) {
      const l = old0.line;
      result.push({ targetDeg: 0, currentDeg: l.currentDeg, startDeg: l.currentDeg, opacity: 1, isNew: false, isDying: false });
    } else if (has0) {
      result.push({ targetDeg: 0, currentDeg: 0, startDeg: 0, opacity: 1, isNew: false, isDying: false });
    }

    // Handle 180° specially
    const old180 = oldSigned.find(o => Math.abs(o.signed) === 180);
    const has180 = newSigned.some(p => Math.abs(p) === 180);
    if (old180 && has180) {
      const l = old180.line;
      result.push({ targetDeg: 180, currentDeg: l.currentDeg, startDeg: l.currentDeg, opacity: 1, isNew: false, isDying: false });
    } else if (has180) {
      result.push({ targetDeg: 180, currentDeg: 180, startDeg: 180, opacity: 1, isNew: false, isDying: false });
    }

    // Process positive side (0 < deg < 180) - outward means toward 180
    const oldPos = oldSigned.filter(o => o.signed > 0 && o.signed < 180).sort((a, b) => b.signed - a.signed);
    const newPos = newSigned.filter(p => p > 0 && p < 180).sort((a, b) => b - a);
    this.matchSide(oldPos.map(o => o.line), newPos.map(p => toUnsigned(p)), result);

    // Process negative side (-180 < deg < 0) - outward means toward -180
    const oldNeg = oldSigned.filter(o => o.signed < 0 && o.signed > -180).sort((a, b) => a.signed - b.signed);
    const newNeg = newSigned.filter(p => p < 0 && p > -180).sort((a, b) => a - b);
    this.matchSide(oldNeg.map(o => o.line), newNeg.map(p => toUnsigned(p)), result);

    this.lonLines = result;
  }

  private transitionLatLines(lines: LineState[], targetPositions: number[]): void {
    const result: LineState[] = [];

    // Use currentDeg for grouping (where lines actually are now)
    const oldLines = lines.map(l => ({ line: l, deg: l.currentDeg }));
    const newDegs = [...targetPositions];

    // Handle 0° (equator) specially - always stays
    const old0 = oldLines.find(o => o.deg === 0);
    const has0 = newDegs.includes(0);
    if (old0 && has0) {
      const l = old0.line;
      result.push({ targetDeg: 0, currentDeg: l.currentDeg, startDeg: l.currentDeg, opacity: 1, isNew: false, isDying: false });
    } else if (has0) {
      result.push({ targetDeg: 0, currentDeg: 0, startDeg: 0, opacity: 1, isNew: false, isDying: false });
    }

    // Process north hemisphere (0 < lat <= 90) - outward means toward 90
    const oldNorth = oldLines.filter(o => o.deg > 0).sort((a, b) => b.deg - a.deg);
    const newNorth = newDegs.filter(p => p > 0).sort((a, b) => b - a);
    this.matchSide(oldNorth.map(o => o.line), newNorth, result);

    // Process south hemisphere (-90 <= lat < 0) - outward means toward -90
    const oldSouth = oldLines.filter(o => o.deg < 0).sort((a, b) => a.deg - b.deg);
    const newSouth = newDegs.filter(p => p < 0).sort((a, b) => a - b);
    this.matchSide(oldSouth.map(o => o.line), newSouth, result);

    this.latLines = result;
  }

  /**
   * Find nearest position from candidates, preferring inner (closer to 0°) on tie
   */
  private findNearest(target: number, candidates: number[]): number {
    if (candidates.length === 0) return 0;
    let nearest = candidates[0]!;
    let nearestDist = Math.abs(target - nearest);
    for (const pos of candidates) {
      const dist = Math.abs(target - pos);
      // Prefer inner (smaller abs) on tie
      if (dist < nearestDist || (dist === nearestDist && Math.abs(pos) < Math.abs(nearest))) {
        nearest = pos;
        nearestDist = dist;
      }
    }
    return nearest;
  }

  /**
   * Match old lines to new positions using nearest-neighbor matching
   * Each old line slides to its nearest new position, remaining new positions birth new lines
   */
  private matchSide(
    oldLines: LineState[],
    newPositions: number[],
    result: LineState[]
  ): void {
    const oldPositions = oldLines.map(l => l.currentDeg);
    const claimedNew = new Set<number>();

    // Step 1: Each old line claims its nearest new position
    for (const old of oldLines) {
      const nearestNew = this.findNearest(old.currentDeg, newPositions);
      if (!claimedNew.has(nearestNew)) {
        // Slide to nearest new position
        claimedNew.add(nearestNew);
        result.push({
          targetDeg: nearestNew,
          currentDeg: old.currentDeg,
          startDeg: old.currentDeg,
          opacity: 1,
          isNew: false,
          isDying: false,
        });
      } else {
        // Position already claimed, this line dies toward it
        result.push({
          targetDeg: nearestNew,
          currentDeg: old.currentDeg,
          startDeg: old.currentDeg,
          opacity: 1,
          isNew: false,
          isDying: true,
        });
      }
    }

    // Step 2: Unclaimed new positions birth new lines from nearest old
    for (const newPos of newPositions) {
      if (!claimedNew.has(newPos)) {
        const nearestOld = this.findNearest(newPos, oldPositions);
        result.push({
          targetDeg: newPos,
          currentDeg: nearestOld,
          startDeg: nearestOld,
          opacity: 1,
          isNew: true,
          isDying: false,
        });
      }
    }
  }

  private updateAnimation(dt: number): void {
    this.animationProgress += dt / ANIMATION_DURATION;

    const t = Math.min(this.animationProgress, 1);
    const eased = this.easeOutCubic(t);

    let allComplete = true;

    // Update longitude lines
    for (const line of this.lonLines) {
      if (line.isNew || line.isDying || line.startDeg !== line.targetDeg) {
        line.currentDeg = this.lerpAngle(line.startDeg, line.targetDeg, eased, true);
        if (t < 1) allComplete = false;
      }
    }

    // Update latitude lines
    for (const line of this.latLines) {
      if (line.isNew || line.isDying || line.startDeg !== line.targetDeg) {
        line.currentDeg = this.lerp(line.startDeg, line.targetDeg, eased);
        if (t < 1) allComplete = false;
      }
    }

    if (allComplete) {
      this.finishAnimation();
    }
  }

  private finishAnimation(): void {
    this.animating = false;
    this.animationProgress = 0;

    // Finalize line states
    for (const line of this.lonLines) {
      line.currentDeg = line.targetDeg;
      line.opacity = 1;
      line.isNew = false;
    }
    for (const line of this.latLines) {
      line.currentDeg = line.targetDeg;
      line.opacity = 1;
      line.isNew = false;
    }

    // Remove dead lines
    this.lonLines = this.lonLines.filter(l => !l.isDying);
    this.latLines = this.latLines.filter(l => !l.isDying);
  }

  // Easing function
  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  // Linear interpolation
  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  // Angle interpolation (handles wraparound for longitude)
  private lerpAngle(a: number, b: number, t: number, isLon: boolean): number {
    if (!isLon) return this.lerp(a, b, t);

    // For longitude, find shortest path
    let diff = b - a;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    let result = a + diff * t;
    // Normalize to 0-360 range for shader
    if (result < 0) result += 360;
    if (result >= 360) result -= 360;
    return result;
  }

  // Getters for debugging
  get currentLod(): number { return this.lodLevel; }
  get isAnimating(): boolean { return this.animating; }

  /**
   * Pack grid lines directly to GPU buffer format
   * Layout: 20 vec4s each for lonDeg, lonOpacity, latDeg, latOpacity + counts
   */
  packToBuffer(globeRadiusPx: number, dt: number): ArrayBuffer {
    this.checkLodTransition(globeRadiusPx);
    if (this.animating) this.updateAnimation(dt);

    const buffer = new ArrayBuffer(GRID_BUFFER_SIZE);
    const view = new DataView(buffer);
    let offset = 0;

    // Longitude degrees (80 floats = 320 bytes)
    for (let i = 0; i < MAX_LINES; i++) {
      view.setFloat32(offset, this.lonLines[i]?.currentDeg ?? 0, true);
      offset += 4;
    }

    // Longitude opacities (80 floats = 320 bytes)
    for (let i = 0; i < MAX_LINES; i++) {
      view.setFloat32(offset, this.lonLines[i]?.opacity ?? 0, true);
      offset += 4;
    }

    // Latitude degrees (80 floats = 320 bytes)
    for (let i = 0; i < MAX_LINES; i++) {
      view.setFloat32(offset, this.latLines[i]?.currentDeg ?? 0, true);
      offset += 4;
    }

    // Latitude opacities (80 floats = 320 bytes)
    for (let i = 0; i < MAX_LINES; i++) {
      view.setFloat32(offset, this.latLines[i]?.opacity ?? 0, true);
      offset += 4;
    }

    // Counts and animation state (32 bytes)
    view.setUint32(offset, this.lonLines.length, true);
    view.setUint32(offset + 4, this.latLines.length, true);
    view.setUint32(offset + 8, this.animating ? 1 : 0, true);
    const level = LOD_LEVELS[this.lodLevel]!;
    view.setFloat32(offset + 12, level.spacing, true);
    // offset + 16..31 = padding

    return buffer;
  }
}

