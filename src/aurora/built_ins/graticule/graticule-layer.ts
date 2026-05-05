/**
 * GraticuleLayer — built-in AuroraLayer for animated lat/lon graticule overlay.
 *
 * Wraps GraticuleAnimator (CPU LoD state machine), writes per-frame line state to
 * the shared lines buffer (binding 21). Render path is composed via main.wesl's
 * blendGraticule; this plugin only contributes initialize + update.
 *
 * fontSize/lineWidth (CSS pixels) flow in via onOptionsChanged; update() applies
 * frame.dpr to write the GPU uniforms in render-pixel units each frame.
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
  private uniformView!: DataView;

  // CSS-pixel option values cached from onOptionsChanged; multiplied by frame.dpr
  // each tick to write render-pixel uniforms the shader consumes.
  private fontSizeCss = 0;
  private lineWidthCss = 0;

  constructor(
    private readonly initialGlobeRadiusPx: number,
    private readonly linesBuffer: GPUBuffer,
  ) {}

  initialize(ctx: AuroraLayerContext): void {
    this.device = ctx.device;
    this.uniformView = ctx.uniformView;
    this.animator = new GraticuleAnimator(this.initialGlobeRadiusPx, GRATICULE_DEFAULT_LOD_LEVELS);
    // Aurora-internal uniform: written once at registration (was host's writeConfigUniforms).
    ctx.uniformView.setFloat32(U.graticuleLabelMaxRadius, LABEL_MAX_RADIUS_PX, true);
  }

  onDataChanged(_ctx: AuroraLayerContext, _events: AuroraDataEvent[]): void {
    // Graticule has no data buffers
  }

  onOptionsChanged(_ctx: AuroraLayerContext, options: Record<string, unknown>): void {
    if ('fontSize' in options && typeof options.fontSize === 'number') {
      this.fontSizeCss = options.fontSize;
    }
    if ('lineWidth' in options && typeof options.lineWidth === 'number') {
      this.lineWidthCss = options.lineWidth;
    }
  }

  compute(_frame: AuroraLayerFrame): boolean {
    return false;
  }

  update(frame: AuroraLayerFrame): void {
    const buf = this.animator.packToBuffer(frame.globeRadiusPx, frame.frameDeltaMs);
    this.device.queue.writeBuffer(this.linesBuffer, 0, buf);
    // Shader consumes render-pixel sizes (it scales by worldUnitsPerPixel ∝ 1/render-resolution).
    this.uniformView.setFloat32(U.graticuleFontSize, this.fontSizeCss * frame.dpr, true);
    this.uniformView.setFloat32(U.graticuleLineWidth, this.lineWidthCss * frame.dpr, true);
  }

  render(_frame: AuroraLayerFrame, _pass: GPURenderPassEncoder): void {
    // Composed via blendGraticule/blendGraticuleText in main.wesl; no separate render pass
  }

  dispose(): void {
    // Animator is pure TS; nothing to release
  }
}
