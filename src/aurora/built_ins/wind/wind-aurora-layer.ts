/**
 * WindAuroraLayer — built-in AuroraLayer for animated wind particle field.
 *
 * Wraps WindLayer (compute + render pipelines, particle buffers). Unlike
 * graticule/cities (composed via main.wesl blendXxx), wind has its own GPU
 * compute pass and its own render pass — all three AuroraLayer methods get
 * real bodies.
 *
 * Per-frame cross-layer values (animated opacity, layer state with lerp,
 * cross-layer-derived showBackface for backface culling) flow through a
 * narrow host handle. animSpeed currently flows through the host too pending
 * Sub-B's typed-setters phase.
 *
 * Phase 4 of aurora-autarky Sub-A.
 */

import { WindLayer } from './wind-layer';
import type {
  AuroraDataEvent,
  AuroraLayer,
  AuroraLayerContext,
  AuroraLayerFrame,
} from '../../types/aurora-layer';
import type { LayerState } from '../../../config/types';

export interface WindAuroraLayerConfig {
  snakeLength: number;
  lineWidth: number;
  segmentsPerLine: number;
  stepFactor: number;
  radius: number;
}

export const WIND_DEFAULT_CONFIG: WindAuroraLayerConfig = {
  snakeLength: 0.25,
  lineWidth: 0.002,
  segmentsPerLine: 30,
  stepFactor: 0.005,
  radius: 1.0,
};

/**
 * Host-supplied per-frame values that wind needs but cannot derive locally:
 * - opacity is animated by the host's per-frame opacity-decay system
 * - layerState (mode, lerp, time) is built by the host worker from layer-slot state
 * - animSpeed is sourced from `wind.speed` option (host-owned options state)
 * - showBackface is a cross-layer occlusion-culling hint derived from EARTH/TEMP
 *   opacities; passing it lets wind skip back-hemisphere particles when those
 *   layers are opaque. Pure performance optimization.
 */
export interface WindAuroraLayerHost {
  getOpacity(): number;
  getLayerState(): LayerState;
  getAnimSpeed(): number;
  getShowBackface(): number;
}

const PALETTE_NAME = 'wind-speed';
const U_PARAM = 'wind_u_component_10m';
const V_PARAM = 'wind_v_component_10m';

export class WindAuroraLayer implements AuroraLayer {
  readonly id = 'wind';
  readonly order = 20;

  private inner!: WindLayer;
  private paletteIndex = 0;
  private paletteCount = 0;

  // Cached u/v buffers between onDataChanged events; setExternalBuffers needs all 4 at once.
  private uBuffer0: GPUBuffer | null = null;
  private uBuffer1: GPUBuffer | null = null;
  private vBuffer0: GPUBuffer | null = null;
  private vBuffer1: GPUBuffer | null = null;

  constructor(
    private readonly lineCount: number,
    private readonly host: WindAuroraLayerHost,
  ) {}

  initialize(ctx: AuroraLayerContext): void {
    this.inner = new WindLayer(
      ctx.device,
      ctx.format,
      ctx.paletteTexture,
      this.lineCount,
      WIND_DEFAULT_CONFIG,
    );
    this.paletteIndex = ctx.paletteTexture.getPaletteIndex(PALETTE_NAME);
    this.paletteCount = ctx.paletteTexture.paletteCount;
  }

  onDataChanged(ctx: AuroraLayerContext, events: AuroraDataEvent[]): void {
    for (const ev of events) {
      if (ev.param === U_PARAM) {
        this.uBuffer0 = ev.buffer0;
        this.uBuffer1 = ev.buffer1;
      } else if (ev.param === V_PARAM) {
        this.vBuffer0 = ev.buffer0;
        this.vBuffer1 = ev.buffer1;
      }
    }
    if (this.uBuffer0 && this.uBuffer1 && this.vBuffer0 && this.vBuffer1) {
      this.inner.setExternalBuffers(
        this.uBuffer0, this.vBuffer0,
        this.uBuffer1, this.vBuffer1,
        ctx.gaussianGridBuffer,
      );
    }
  }

  onOptionsChanged(_ctx: AuroraLayerContext, options: Record<string, unknown>): void {
    if ('seedCount' in options && typeof options.seedCount === 'number') {
      this.inner.setLineCount(options.seedCount);
    }
  }

  compute(frame: AuroraLayerFrame): boolean {
    if (!this.inner.isEnabled()) return false;
    return this.inner.runCompute(frame.commandEncoder);
  }

  update(frame: AuroraLayerFrame): void {
    const opacity = this.host.getOpacity();
    const state = this.host.getLayerState();
    const active = opacity > 0.01 && state.mode === 'pair';
    this.inner.setEnabled(active);
    if (!active) return;

    this.inner.advanceAnimation(frame.frameDeltaMs, this.host.getAnimSpeed());
    this.inner.setState(state);

    this.inner.updateUniforms({
      viewProj: frame.viewProj,
      eyePosition: [
        frame.eyePosition[0]!,
        frame.eyePosition[1]!,
        frame.eyePosition[2]!,
      ],
      opacity,
      animPhase: this.inner.getAnimPhase(),
      snakeLength: this.inner.getSnakeLength(),
      lineWidth: this.inner.getLineWidth(),
      showBackface: this.host.getShowBackface(),
      radius: this.inner.getRadius(),
      paletteIndex: this.paletteIndex,
      paletteCount: this.paletteCount,
    });
  }

  render(_frame: AuroraLayerFrame, pass: GPURenderPassEncoder): void {
    this.inner.render(pass);
  }

  dispose(): void {
    this.inner?.dispose();
  }
}
