/**
 * PressureAuroraLayer — built-in AuroraLayer for isobar pressure contours.
 *
 * Wraps the inner PressureLayer (multi-pass compute pipeline + line-list render).
 * Per-frame work (opacity gate, render uniforms with cross-layer backface-cull)
 * runs through update/render. The compute orchestration (regrid, contour build,
 * smoothing) is data-event-driven and remains driven by the host worker through
 * globe-renderer forwarders that reach the inner via getInner() — transitional
 * escape hatch slated for Sub-B's data-flow phase.
 *
 * Phase 5 of aurora-autarky Sub-A.
 */

import { PressureLayer } from './pressure-layer';
import type {
  AuroraDataEvent,
  AuroraLayer,
  AuroraLayerContext,
  AuroraLayerFrame,
} from '../../types/aurora-layer';
import type { PressureColorOption } from '../../../schemas/options.schema';

export interface PressureAuroraLayerHost {
  getOpacity(): number;
  getColors(): PressureColorOption;
  /**
   * True when the globe surface (earth/temp/sun) is opaque enough that
   * back-hemisphere isobars are occluded — performance optimization.
   */
  getBackfaceCull(): boolean;
}

export class PressureAuroraLayer implements AuroraLayer {
  readonly id = 'pressure';
  readonly order = 10;

  private inner!: PressureLayer;

  constructor(private readonly host: PressureAuroraLayerHost) {}

  initialize(ctx: AuroraLayerContext): void {
    this.inner = new PressureLayer(ctx.device, ctx.format, ctx.paletteTexture);
  }

  onDataChanged(_ctx: AuroraLayerContext, _events: AuroraDataEvent[]): void {
    // Pressure data feeds in via globe-renderer.triggerPressureRegrid; this
    // surface is unused for now (tracked in deferred ledger).
  }

  onOptionsChanged(_ctx: AuroraLayerContext, _options: Record<string, unknown>): void {
    // pressure.colors flows per-frame via host handle; spacing/smoothing flow
    // through globe-renderer.setPressureLevelCount + runPressureContour. This
    // surface is unused for now (tracked in deferred ledger).
  }

  compute(_frame: AuroraLayerFrame): boolean {
    // Pressure compute (regrid + contour + smoothing) is orchestrated by the
    // host worker via globe-renderer forwarders, not per-frame here.
    return false;
  }

  update(frame: AuroraLayerFrame): void {
    const opacity = this.host.getOpacity();
    const visible = opacity > 0.01;
    this.inner.setEnabled(visible);
    if (!visible) return;

    this.inner.updateUniforms({
      viewProj: frame.viewProj,
      eyePosition: [
        frame.eyePosition[0]!,
        frame.eyePosition[1]!,
        frame.eyePosition[2]!,
      ],
      sunDirection: [
        frame.sunDirection[0]!,
        frame.sunDirection[1]!,
        frame.sunDirection[2]!,
      ],
      opacity,
      backfaceCull: this.host.getBackfaceCull(),
    }, this.host.getColors());
  }

  render(_frame: AuroraLayerFrame, pass: GPURenderPassEncoder): void {
    this.inner.render(pass);
  }

  dispose(): void {
    this.inner?.dispose();
  }

  /**
   * Transitional escape hatch — globe-renderer keeps several pressure-specific
   * external methods (initializePressureLayer, triggerPressureRegrid,
   * runPressureContour, setPressureLevelCount, invalidatePressureGridSlots)
   * that the worker drives. Those forward through here to the inner layer.
   * Removed once compute orchestration moves into aurora (Sub-B data flow).
   */
  getInner(): PressureLayer {
    return this.inner;
  }
}
