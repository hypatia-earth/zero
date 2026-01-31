/**
 * Aurora Worker - GPU rendering in dedicated worker thread
 *
 * Handles all WebGPU operations off the main thread to prevent jank:
 * - OffscreenCanvas rendering
 * - Buffer uploads (writeBuffer)
 * - Render loop
 *
 * Main thread sends camera/options/time updates, worker builds uniforms and renders.
 */

import type { CameraConfig } from '../render/camera';
import type { TWeatherLayer } from '../config/types';

// ============================================================
// Asset types for worker transfer
// ============================================================

export interface AuroraAssets {
  // Atmosphere LUTs (raw binary data)
  atmosphereLUTs: {
    transmittance: ArrayBuffer;
    scattering: ArrayBuffer;
    irradiance: ArrayBuffer;
  };
  // Gaussian grid lookup tables
  gaussianLats: Float32Array;
  ringOffsets: Uint32Array;
  // Decoded images (must be decoded in main thread)
  basemapFaces: ImageBitmap[];
  fontAtlas: ImageBitmap;
  logo: ImageBitmap;
}

export interface AuroraConfig {
  cameraConfig: CameraConfig;
  timeslotsPerLayer: number;
  pressureResolution: 1 | 2;
  windLineCount: number;
  readyLayers: TWeatherLayer[];
}

// ============================================================
// Message types
// ============================================================

export type AuroraRequest =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number; config: AuroraConfig; assets: AuroraAssets }
  | { type: 'render' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'updatePalette'; layer: 'temp'; textureData: Uint8Array; min: number; max: number }
  | { type: 'cleanup' };

export type AuroraResponse =
  | { type: 'ready' }
  | { type: 'frameComplete'; timing?: { frame: number } }
  | { type: 'error'; message: string; fatal: boolean };

// Worker state
let device: GPUDevice | null = null;
let context: GPUCanvasContext | null = null;
let canvas: OffscreenCanvas | null = null;
let format: GPUTextureFormat;
let config: AuroraConfig | null = null;
let assets: AuroraAssets | null = null;

self.onmessage = async (e: MessageEvent<AuroraRequest>) => {
  const { type } = e.data;

  try {
    if (type === 'init') {
      canvas = e.data.canvas;
      canvas.width = e.data.width;
      canvas.height = e.data.height;
      config = e.data.config;
      assets = e.data.assets;

      console.log('[Aurora] Init with config:', {
        timeslotsPerLayer: config.timeslotsPerLayer,
        pressureResolution: config.pressureResolution,
        windLineCount: config.windLineCount,
        readyLayers: config.readyLayers,
      });
      console.log('[Aurora] Assets received:', {
        basemapFaces: assets.basemapFaces.length,
        fontAtlas: `${assets.fontAtlas.width}x${assets.fontAtlas.height}`,
        logo: `${assets.logo.width}x${assets.logo.height}`,
        gaussianLats: assets.gaussianLats.length,
        ringOffsets: assets.ringOffsets.length,
        atmosphereLUTs: {
          transmittance: assets.atmosphereLUTs.transmittance.byteLength,
          scattering: assets.atmosphereLUTs.scattering.byteLength,
          irradiance: assets.atmosphereLUTs.irradiance.byteLength,
        },
      });

      // Request WebGPU adapter
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        self.postMessage({
          type: 'error',
          message: 'No WebGPU adapter available',
          fatal: true,
        } satisfies AuroraResponse);
        return;
      }

      // Request device
      device = await adapter.requestDevice();
      device.lost.then((info) => {
        self.postMessage({
          type: 'error',
          message: `GPU device lost: ${info.reason} - ${info.message}`,
          fatal: true,
        } satisfies AuroraResponse);
      });

      // Configure canvas context
      context = canvas.getContext('webgpu');
      if (!context) {
        self.postMessage({
          type: 'error',
          message: 'Failed to get WebGPU context',
          fatal: true,
        } satisfies AuroraResponse);
        return;
      }

      format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format });

      self.postMessage({ type: 'ready' } satisfies AuroraResponse);
    }

    if (type === 'render') {
      if (!device || !context) {
        self.postMessage({
          type: 'error',
          message: 'Worker not initialized',
          fatal: false,
        } satisfies AuroraResponse);
        return;
      }

      const t0 = performance.now();

      // Render solid color (Phase 1 test)
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.1, g: 0.0, b: 0.2, a: 1.0 },  // Dark purple
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.end();
      device.queue.submit([encoder.finish()]);

      const frameTime = performance.now() - t0;
      self.postMessage({
        type: 'frameComplete',
        timing: { frame: frameTime },
      } satisfies AuroraResponse);
    }

    if (type === 'resize') {
      if (canvas) {
        canvas.width = e.data.width;
        canvas.height = e.data.height;
      }
    }

    if (type === 'updatePalette') {
      // Store palette data for later use (Phase 2: actual GPU upload)
      console.log('[Aurora] Palette update:', e.data.layer, e.data.min, e.data.max);
    }

    if (type === 'cleanup') {
      context?.unconfigure();
      device?.destroy();
      device = null;
      context = null;
      canvas = null;
      config = null;
      assets = null;
    }

  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      fatal: false,
    } satisfies AuroraResponse);
  }
};
