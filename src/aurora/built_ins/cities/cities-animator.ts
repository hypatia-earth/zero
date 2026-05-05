/**
 * CitiesAnimator — LOD transitions with hysteresis and cross-fade
 *
 * Tracks current LOD tier based on globeRadiusPx thresholds.
 * On tier change, cross-fades opacity over ~1s.
 */

import { CitiesLayer } from './cities-layer';
import type { CitiesLodLevel } from './cities-aurora-layer';

const TRANSITION_DURATION = 1000; // ms

export class CitiesAnimator {
  private currentTier: number;
  private targetTier: number;
  private transitioning = false;
  private transitionProgress = 0;
  private readonly lodLevels: CitiesLodLevel[];
  private needsUpload = true;

  constructor(
    private citiesLayer: CitiesLayer,
    initialGlobeRadiusPx: number,
    lodLevels: CitiesLodLevel[]
  ) {
    this.lodLevels = lodLevels;
    this.currentTier = this.getTierForRadius(initialGlobeRadiusPx);
    this.targetTier = this.currentTier;
    this.citiesLayer.currentTierIndex = this.currentTier;
  }

  private getTierForRadius(globeRadiusPx: number): number {
    for (let i = this.lodLevels.length - 1; i >= 0; i--) {
      if (globeRadiusPx >= this.lodLevels[i]!.zoomInPx) {
        return i;
      }
    }
    return 0;
  }

  /** Check for LOD change with hysteresis */
  private checkTransition(globeRadiusPx: number): void {
    // Check if we should zoom in (higher tier)
    for (let i = this.lodLevels.length - 1; i > this.currentTier; i--) {
      if (globeRadiusPx >= this.lodLevels[i]!.zoomInPx) {
        this.startTransition(i);
        return;
      }
    }
    // Check if we should zoom out (lower tier)
    if (this.currentTier > 0 && globeRadiusPx <= this.lodLevels[this.currentTier]!.zoomOutPx) {
      this.startTransition(this.currentTier - 1);
    }
  }

  private startTransition(newTier: number): void {
    if (this.transitioning && this.targetTier === newTier) return;
    this.targetTier = newTier;
    this.transitioning = true;
    this.transitionProgress = 0;
  }

  /** Update animation state. Returns true if GPU upload needed. */
  update(globeRadiusPx: number, frameDeltaMs: number): boolean {
    this.checkTransition(globeRadiusPx);

    if (this.transitioning) {
      this.transitionProgress += frameDeltaMs / TRANSITION_DURATION;

      if (this.transitionProgress >= 1) {
        this.currentTier = this.targetTier;
        this.citiesLayer.currentTierIndex = this.currentTier;
        this.transitioning = false;
        this.transitionProgress = 0;
        this.needsUpload = true;
      } else {
        // Mid-transition: swap to new tier at halfway point
        if (this.transitionProgress >= 0.5 && this.citiesLayer.currentTierIndex !== this.targetTier) {
          this.currentTier = this.targetTier;
          this.citiesLayer.currentTierIndex = this.currentTier;
          this.needsUpload = true;
        }
      }
    }

    const upload = this.needsUpload;
    this.needsUpload = false;
    return upload;
  }

  /** Get cross-fade opacity multiplier (1.0 = fully visible, dips during transition) */
  get fadeOpacity(): number {
    if (!this.transitioning) return 1.0;
    // Fade out then in: V-shape curve
    const t = this.transitionProgress;
    return t < 0.5
      ? 1.0 - t * 2      // fade out 1→0
      : (t - 0.5) * 2;   // fade in 0→1
  }

  get activeTier(): number { return this.currentTier; }
  get isTransitioning(): boolean { return this.transitioning; }
}
