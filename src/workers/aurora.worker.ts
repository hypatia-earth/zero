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
import { GlobeRenderer, type GlobeUniforms } from '../render/globe-renderer';
import { PRESSURE_COLOR_DEFAULT } from '../schemas/options.schema';

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

// ============================================================
// Worker state
// ============================================================

let renderer: GlobeRenderer | null = null;
let canvas: OffscreenCanvas | null = null;

/**
 * Create default uniforms for testing (Phase 2)
 * Will be replaced by proper state forwarding
 */
function createDefaultUniforms(): GlobeUniforms {
  // Get camera matrices from renderer's camera
  const cam = renderer!.camera;
  return {
    viewProjInverse: cam.getViewProjInverse(),
    eyePosition: cam.getEyePosition(),
    resolution: new Float32Array([canvas!.width, canvas!.height]),
    time: performance.now() / 1000,
    tanFov: cam.getTanFov(),
    // Sun
    sunOpacity: 1.0,
    sunDirection: new Float32Array([0.5, 0.5, 0.707]),
    sunCoreRadius: 0.005,
    sunGlowRadius: 0.02,
    sunCoreColor: new Float32Array([1, 1, 0.9]),
    sunGlowColor: new Float32Array([1, 0.8, 0.4]),
    // Grid
    gridEnabled: false,
    gridOpacity: 0,
    gridFontSize: 12,
    gridLabelMaxRadius: 280,
    gridLineWidth: 1,
    // Layers
    earthOpacity: 1.0,
    tempOpacity: 0,
    rainOpacity: 0,
    cloudsOpacity: 0,
    humidityOpacity: 0,
    windOpacity: 0,
    windLerp: 0,
    windAnimSpeed: 1,
    windState: { mode: 'loading', lerp: 0, time: new Date() },
    pressureOpacity: 0,
    pressureColors: PRESSURE_COLOR_DEFAULT,
    // Data state
    tempDataReady: false,
    rainDataReady: false,
    cloudsDataReady: false,
    humidityDataReady: false,
    windDataReady: false,
    tempLerp: 0,
    tempLoadedPoints: 0,
    tempSlot0: 0,
    tempSlot1: 0,
    tempPaletteRange: new Float32Array([-40, 50]),
    logoOpacity: 0,
  };
}

self.onmessage = async (e: MessageEvent<AuroraRequest>) => {
  const { type } = e.data;

  try {
    if (type === 'init') {
      const { config, assets } = e.data;
      canvas = e.data.canvas;
      canvas.width = e.data.width;
      canvas.height = e.data.height;

      console.log('[Aurora] Initializing GlobeRenderer...');

      // Create and initialize renderer
      renderer = new GlobeRenderer(canvas, config.cameraConfig);
      await renderer.initialize(
        config.timeslotsPerLayer,
        config.pressureResolution,
        config.windLineCount
      );

      // Upload assets
      renderer.createAtmosphereTextures(assets.atmosphereLUTs);
      await renderer.loadBasemap(assets.basemapFaces);
      await renderer.loadFontAtlas(assets.fontAtlas);
      await renderer.loadLogo(assets.logo);
      renderer.uploadGaussianLUTs(assets.gaussianLats, assets.ringOffsets);

      // Finalize renderer (creates bind groups)
      renderer.finalize();

      console.log('[Aurora] GlobeRenderer ready');
      self.postMessage({ type: 'ready' } satisfies AuroraResponse);
    }

    if (type === 'render') {
      if (!renderer) {
        self.postMessage({
          type: 'error',
          message: 'Worker not initialized',
          fatal: false,
        } satisfies AuroraResponse);
        return;
      }

      const t0 = performance.now();

      // Update uniforms and render
      const uniforms = createDefaultUniforms();
      renderer.updateUniforms(uniforms);
      renderer.render();

      const frameTime = performance.now() - t0;
      self.postMessage({
        type: 'frameComplete',
        timing: { frame: frameTime },
      } satisfies AuroraResponse);
    }

    if (type === 'resize') {
      if (renderer && canvas) {
        canvas.width = e.data.width;
        canvas.height = e.data.height;
        renderer.resize(e.data.width, e.data.height);
      }
    }

    if (type === 'updatePalette') {
      if (renderer) {
        renderer.updateTempPalette(e.data.textureData);
      }
    }

    if (type === 'cleanup') {
      renderer?.dispose();
      renderer = null;
      canvas = null;
    }

  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      fatal: false,
    } satisfies AuroraResponse);
  }
};
