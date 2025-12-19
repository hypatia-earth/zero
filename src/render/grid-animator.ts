/**
 * GridAnimator - Manages animated grid LoD transitions
 *
 * Lines are born at 0° and slide to position, reverse for death.
 * LoD level changes based on altitude with hysteresis.
 */

// LoD level configuration
interface LodLevel {
  lonSpacing: number;   // degrees between longitude lines
  latSpacing: number;   // degrees between latitude lines
  zoomIn: number;       // altitude (km) to transition TO this level
  zoomOut: number;      // altitude (km) to transition FROM this level
}

// Per-line animation state
interface LineState {
  targetDeg: number;    // final position in degrees
  currentDeg: number;   // animated position
  startDeg: number;     // position when animation started (for dying lines)
  opacity: number;      // 0-1 for fade in/out
  isNew: boolean;       // just born, animating from 0°
  isDying: boolean;     // converging to 0° to die
}

// Uniform data for shader
export interface GridLinesUniforms {
  lonDegrees: Float32Array;   // MAX_LINES floats
  lonOpacities: Float32Array; // MAX_LINES floats
  lonCount: number;
  latDegrees: Float32Array;   // MAX_LINES floats
  latOpacities: Float32Array; // MAX_LINES floats
  latCount: number;
}

// Constants
const MAX_LINES = 80;  // max lines per axis (72 lon + margin)
const ANIMATION_DURATION = 1000;  // ms per birth/death cycle

// LoD levels from feature spec
// zoomIn: altitude to transition TO this level (getting closer)
// zoomOut: altitude to transition FROM this level back to previous (getting further)
const LOD_LEVELS: LodLevel[] = [
  { lonSpacing: 90, latSpacing: 90, zoomIn: Infinity, zoomOut: Infinity },  // LoD 0: can't zoom out
  { lonSpacing: 60, latSpacing: 30, zoomIn: 23000, zoomOut: 27000 },        // 0→1: in<23k, out>27k
  { lonSpacing: 45, latSpacing: 45, zoomIn: 13000, zoomOut: 17000 },        // 1→2: in<13k, out>17k
  { lonSpacing: 30, latSpacing: 30, zoomIn: 7000, zoomOut: 9000 },          // 2→3: in<7k, out>9k
  { lonSpacing: 15, latSpacing: 15, zoomIn: 3500, zoomOut: 4500 },          // 3→4: in<3.5k, out>4.5k
  { lonSpacing: 10, latSpacing: 10, zoomIn: 1700, zoomOut: 2300 },          // 4→5: in<1.7k, out>2.3k
  { lonSpacing: 5, latSpacing: 5, zoomIn: 700, zoomOut: 900 },              // 5→6: in<700, out>900
];

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

  // Cached uniform arrays (reused each frame)
  private uniforms: GridLinesUniforms = {
    lonDegrees: new Float32Array(MAX_LINES),
    lonOpacities: new Float32Array(MAX_LINES),
    lonCount: 0,
    latDegrees: new Float32Array(MAX_LINES),
    latOpacities: new Float32Array(MAX_LINES),
    latCount: 0,
  };

  constructor(initialAltitudeKm: number) {
    // Find correct LoD for starting altitude
    this.lodLevel = this.getLodForAltitude(initialAltitudeKm);
    console.log(`GridAnimator init: altitude=${initialAltitudeKm}km, LoD=${this.lodLevel}`);
    this.initializeLines();
  }

  private getLodForAltitude(altitude: number): number {
    // Find highest LoD level where altitude is below zoomIn threshold
    for (let i = LOD_LEVELS.length - 1; i >= 0; i--) {
      if (altitude < LOD_LEVELS[i]!.zoomIn) {
        return i;
      }
    }
    return 0;
  }

  private initializeLines(): void {
    const level = LOD_LEVELS[this.lodLevel]!;

    // Initialize longitude lines
    this.lonLines = generateLonLines(level.lonSpacing).map(deg => ({
      targetDeg: deg,
      currentDeg: deg,
      startDeg: deg,
      opacity: 1,
      isNew: false,
      isDying: false,
    }));

    // Initialize latitude lines
    this.latLines = generateLatLines(level.latSpacing).map(deg => ({
      targetDeg: deg,
      currentDeg: deg,
      startDeg: deg,
      opacity: 1,
      isNew: false,
      isDying: false,
    }));
  }

  /**
   * Update animation state based on altitude
   * @param altitude Camera altitude in km
   * @param dt Delta time in ms
   * @returns Uniform data for shader
   */
  update(altitude: number, dt: number): GridLinesUniforms {
    // Check for LoD transition (with hysteresis)
    this.checkLodTransition(altitude);

    // Update animations
    if (this.animating) {
      this.updateAnimation(dt);
    }

    // Pack uniforms
    this.packUniforms();

    return this.uniforms;
  }

  private checkLodTransition(altitude: number): void {
    if (this.animating) return;  // Don't change during animation

    const currentLevel = this.lodLevel;
    const targetLevel = this.getLodForAltitude(altitude);

    // Jump directly to correct level if more than 1 level off (e.g., camera moved dramatically)
    if (Math.abs(targetLevel - currentLevel) > 1) {
      console.log(`GridAnimator: LoD ${currentLevel} → ${targetLevel} (jump) at altitude=${altitude}km`);
      this.lodLevel = targetLevel;
      this.initializeLines();
      return;
    }

    let newLevel = currentLevel;

    // Check zoom in (need more lines) - use hysteresis
    if (currentLevel < LOD_LEVELS.length - 1) {
      const nextLevel = LOD_LEVELS[currentLevel + 1]!;
      if (altitude < nextLevel.zoomIn) {
        newLevel = currentLevel + 1;
      }
    }

    // Check zoom out (need fewer lines) - use hysteresis
    if (currentLevel > 0) {
      const thisLevel = LOD_LEVELS[currentLevel]!;
      if (altitude > thisLevel.zoomOut) {
        newLevel = currentLevel - 1;
      }
    }

    if (newLevel !== currentLevel) {
      console.log(`GridAnimator: LoD ${currentLevel} → ${newLevel} at altitude=${altitude}km`);
      this.startTransition(newLevel);
    }
  }

  private startTransition(newLevel: number): void {
    const targetLevel = LOD_LEVELS[newLevel]!;

    this.lodLevel = newLevel;
    this.animating = true;
    this.animationProgress = 0;

    // Calculate target line positions
    const targetLonPositions = generateLonLines(targetLevel.lonSpacing);
    const targetLatPositions = generateLatLines(targetLevel.latSpacing);

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

    const oldSigned = lines.map(l => ({ line: l, signed: toSigned(l.targetDeg) }));
    const newSigned = targetPositions.map(p => toSigned(p));

    // Handle 0° specially - always stays if in both sets
    const old0 = oldSigned.find(o => o.signed === 0);
    const has0 = newSigned.includes(0);
    if (old0 && has0) {
      result.push(old0.line);
    } else if (has0) {
      result.push({ targetDeg: 0, currentDeg: 0, startDeg: 0, opacity: 1, isNew: false, isDying: false });
    }

    // Handle 180° specially
    const old180 = oldSigned.find(o => Math.abs(o.signed) === 180);
    const has180 = newSigned.some(p => Math.abs(p) === 180);
    if (old180 && has180) {
      result.push(old180.line);
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

    // Lat lines are already -90 to 90, no conversion needed
    const oldLines = lines.map(l => ({ line: l, deg: l.targetDeg }));
    const newDegs = [...targetPositions];

    // Handle 0° (equator) specially - always stays
    const old0 = oldLines.find(o => o.deg === 0);
    const has0 = newDegs.includes(0);
    if (old0 && has0) {
      result.push(old0.line);
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
   * Match old lines to new positions for one side of the globe
   * Lines are sorted outermost-first
   */
  private matchSide(
    oldLines: LineState[],
    newPositions: number[],
    result: LineState[]
  ): void {
    const maxLen = Math.max(oldLines.length, newPositions.length);

    for (let i = 0; i < maxLen; i++) {
      if (i < oldLines.length && i < newPositions.length) {
        // Old line slides to new position (outward or inward)
        const old = oldLines[i]!;
        const newDeg = newPositions[i]!;
        result.push({
          targetDeg: newDeg,
          currentDeg: old.currentDeg,
          startDeg: old.currentDeg,
          opacity: 1,
          isNew: false,
          isDying: false,
        });
      } else if (i < newPositions.length) {
        // New line born from 0°
        result.push({
          targetDeg: newPositions[i]!,
          currentDeg: 0,
          startDeg: 0,
          opacity: 1,
          isNew: true,
          isDying: false,
        });
      } else {
        // Old line dies toward 0°
        const old = oldLines[i]!;
        result.push({
          targetDeg: 0,
          currentDeg: old.currentDeg,
          startDeg: old.currentDeg,
          opacity: 1,
          isNew: false,
          isDying: true,
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
      if (line.isNew) {
        // Slide from 0° to target
        line.currentDeg = this.lerpAngle(0, line.targetDeg, eased, true);
        line.opacity = 1;
        if (t < 1) allComplete = false;
      } else if (line.isDying) {
        // Slide from saved start toward 0°
        line.currentDeg = this.lerpAngle(line.startDeg, 0, eased, true);
        line.opacity = 1;
        if (t < 1) allComplete = false;
      } else if (line.startDeg !== line.targetDeg) {
        // Slide from start to target (redistribution)
        line.currentDeg = this.lerpAngle(line.startDeg, line.targetDeg, eased, true);
        if (t < 1) allComplete = false;
      }
    }

    // Update latitude lines
    for (const line of this.latLines) {
      if (line.isNew) {
        line.currentDeg = this.lerp(0, line.targetDeg, eased);
        line.opacity = 1;
        if (t < 1) allComplete = false;
      } else if (line.isDying) {
        // Slide from saved start toward 0°
        line.currentDeg = this.lerp(line.startDeg, 0, eased);
        line.opacity = 1;
        if (t < 1) allComplete = false;
      } else if (line.startDeg !== line.targetDeg) {
        // Slide from start to target (redistribution)
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

  private packUniforms(): void {
    // Pack longitude lines
    this.uniforms.lonCount = this.lonLines.length;
    for (let i = 0; i < MAX_LINES; i++) {
      if (i < this.lonLines.length) {
        this.uniforms.lonDegrees[i] = this.lonLines[i]!.currentDeg;
        this.uniforms.lonOpacities[i] = this.lonLines[i]!.opacity;
      } else {
        this.uniforms.lonDegrees[i] = 0;
        this.uniforms.lonOpacities[i] = 0;
      }
    }

    // Pack latitude lines
    this.uniforms.latCount = this.latLines.length;
    for (let i = 0; i < MAX_LINES; i++) {
      if (i < this.latLines.length) {
        this.uniforms.latDegrees[i] = this.latLines[i]!.currentDeg;
        this.uniforms.latOpacities[i] = this.latLines[i]!.opacity;
      } else {
        this.uniforms.latDegrees[i] = 0;
        this.uniforms.latOpacities[i] = 0;
      }
    }
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

}
