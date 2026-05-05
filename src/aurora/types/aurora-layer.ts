/**
 * AuroraLayer — Aurora's internal interface for compute/render-active layers.
 *
 * Per Sub-A plan (zero-arch-aurora-layers.md): aurora's render loop dispatches
 * generically through an AuroraLayerRegistry. The same interface is the escape
 * hatch for app-side experimental layers (e.g. Aether sim fields).
 *
 * Lives in src/aurora/types/ for now; moves to @hypatia/types when aurora extracts
 * to its own package.
 */

import type { PaletteTexture } from '../palette-texture';

export interface AuroraLayerContext {
  device: GPUDevice;
  format: GPUTextureFormat;
  paletteTexture: PaletteTexture;
  gaussianGridBuffer: GPUBuffer;
  uniformBuffer: GPUBuffer;
}

export interface AuroraLayerFrame {
  commandEncoder: GPUCommandEncoder;
  viewProj: Float32Array;
  eyePosition: Float32Array;
  sunDirection: Float32Array;
  opacity: number;
  dataReady: boolean;
  frameDeltaMs: number;
  globeRadiusPx: number;
  time: Date;
}

export interface AuroraDataEvent {
  param: string;
  buffer0: GPUBuffer;
  buffer1: GPUBuffer;
  lerp: number;
}

export interface AuroraLayer {
  readonly id: string;
  readonly order: number;

  initialize(ctx: AuroraLayerContext): void;
  onDataChanged(ctx: AuroraLayerContext, events: AuroraDataEvent[]): void;
  onOptionsChanged(ctx: AuroraLayerContext, options: Record<string, unknown>): void;

  compute(frame: AuroraLayerFrame): boolean;
  update(frame: AuroraLayerFrame): void;
  render(frame: AuroraLayerFrame, pass: GPURenderPassEncoder): void;

  dispose(): void;
}
