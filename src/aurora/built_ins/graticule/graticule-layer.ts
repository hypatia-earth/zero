/**
 * GraticuleLayer — built-in AuroraLayer for animated lat/lon graticule overlay.
 *
 * Wraps GraticuleAnimator (CPU LoD state machine), writes per-frame line state to
 * the shared lines buffer (binding 21). Render path is composed via main.wesl's
 * blendGraticule; this plugin only contributes initialize + update.
 *
 * Phase 2 of aurora-autarky Sub-A. fontSize/lineWidth uniforms still written by
 * host worker; moves into onOptionsChanged in a later phase.
 */

import { GraticuleAnimator } from './graticule-animator';
import { U } from '../../globe-uniforms';
import type {
  AuroraDataEvent,
  AuroraLayer,
  AuroraLayerContext,
  AuroraLayerFrame,
} from '../../types/aurora-layer';

export interface GraticuleLodLevel {
  spacing: number;     // degrees between graticule lines (same for lon/lat)
  zoomInPx: number;    // enter this LoD when globeRadiusPx >= this
  zoomOutPx: number;   // leave this LoD when globeRadiusPx <= this
}

export const GRATICULE_DEFAULT_LOD_LEVELS: GraticuleLodLevel[] = [
  { spacing: 30, zoomInPx: 0,   zoomOutPx: 0 },
  { spacing: 20, zoomInPx: 200, zoomOutPx: 170 },
  { spacing: 15, zoomInPx: 350, zoomOutPx: 300 },
  { spacing: 10, zoomInPx: 500, zoomOutPx: 450 },
  { spacing: 5,  zoomInPx: 650, zoomOutPx: 600 },
];

const LABEL_MAX_RADIUS_PX = 500;

export class GraticuleLayer implements AuroraLayer {
  readonly id = 'graticule';
  readonly order = 30;

  private animator!: GraticuleAnimator;
  private device!: GPUDevice;

  constructor(
    private readonly initialGlobeRadiusPx: number,
    private readonly linesBuffer: GPUBuffer,
  ) {}

  initialize(ctx: AuroraLayerContext): void {
    this.device = ctx.device;
    this.animator = new GraticuleAnimator(this.initialGlobeRadiusPx, GRATICULE_DEFAULT_LOD_LEVELS);
    // Aurora-internal uniform: written once at registration (was host's writeConfigUniforms).
    ctx.uniformView.setFloat32(U.graticuleLabelMaxRadius, LABEL_MAX_RADIUS_PX, true);
  }

  onDataChanged(_ctx: AuroraLayerContext, _events: AuroraDataEvent[]): void {
    // Graticule has no data buffers
  }

  onOptionsChanged(_ctx: AuroraLayerContext, _options: Record<string, unknown>): void {
    // Phase 2: fontSize/lineWidth still flow through host worker uniform writes.
    // Will move here in a later phase.
  }

  compute(_frame: AuroraLayerFrame): boolean {
    return false;
  }

  update(frame: AuroraLayerFrame): void {
    const buf = this.animator.packToBuffer(frame.globeRadiusPx, frame.frameDeltaMs);
    this.device.queue.writeBuffer(this.linesBuffer, 0, buf);
  }

  render(_frame: AuroraLayerFrame, _pass: GPURenderPassEncoder): void {
    // Composed via blendGraticule/blendGraticuleText in main.wesl; no separate render pass
  }

  dispose(): void {
    // Animator is pure TS; nothing to release
  }
}
