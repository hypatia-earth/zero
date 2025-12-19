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
const ANIMATION_DURATION = 200;  // ms per birth/death cycle

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
  private lodLevel = 4;  // Start at 15° spacing
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

  constructor() {
    this.initializeLines();
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
    let newLevel = currentLevel;

    // Check zoom in (need more lines)
    if (currentLevel < LOD_LEVELS.length - 1) {
      const nextLevel = LOD_LEVELS[currentLevel + 1]!;
      if (altitude < nextLevel.zoomIn) {
        newLevel = currentLevel + 1;
      }
    }

    // Check zoom out (need fewer lines)
    if (currentLevel > 0) {
      const thisLevel = LOD_LEVELS[currentLevel]!;
      if (altitude > thisLevel.zoomOut) {
        newLevel = currentLevel - 1;
      }
    }

    if (newLevel !== currentLevel) {
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

  private transitionLines(
    lines: LineState[],
    targetPositions: number[],
    isLon: boolean
  ): void {
    const targetSet = new Set(targetPositions);
    const currentSet = new Set(lines.map(l => l.targetDeg));
    const newLines: LineState[] = [];

    // Keep or mark for death existing lines
    for (const line of lines) {
      if (targetSet.has(line.targetDeg)) {
        // Keep existing line
        newLines.push(line);
      } else {
        // Mark for death - will slide toward 0°
        line.isDying = true;
        line.startDeg = line.currentDeg;
        line.targetDeg = 0;
        newLines.push(line);
      }
    }

    // Add new lines that don't exist yet (born from 0°)
    for (const deg of targetPositions) {
      if (!currentSet.has(deg)) {
        newLines.push({
          targetDeg: deg,
          currentDeg: 0,
          startDeg: 0,
          opacity: 0,
          isNew: true,
          isDying: false,
        });
      }
    }

    if (isLon) {
      this.lonLines = newLines;
    } else {
      this.latLines = newLines;
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
        line.opacity = Math.min(t * 2, 1);  // Fade in faster
        if (t < 1) allComplete = false;
      } else if (line.isDying) {
        // Slide from saved start toward 0° and fade out
        line.currentDeg = this.lerpAngle(line.startDeg, 0, eased, true);
        line.opacity = Math.max(1 - t * 2, 0);  // Fade out faster
        if (t < 1) allComplete = false;
      }
    }

    // Update latitude lines
    for (const line of this.latLines) {
      if (line.isNew) {
        line.currentDeg = this.lerp(0, line.targetDeg, eased);
        line.opacity = Math.min(t * 2, 1);
        if (t < 1) allComplete = false;
      } else if (line.isDying) {
        // Slide from saved start toward 0°
        line.currentDeg = this.lerp(line.startDeg, 0, eased);
        line.opacity = Math.max(1 - t * 2, 0);
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
    return a + diff * t;
  }

  // Getters for debugging
  get currentLod(): number { return this.lodLevel; }
  get isAnimating(): boolean { return this.animating; }

}
