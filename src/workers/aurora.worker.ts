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
import { PRESSURE_COLOR_DEFAULT, type ZeroOptions } from '../schemas/options.schema';
import { getSunDirection } from '../utils/sun-position';

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
  | { type: 'camera'; viewProjInverse: Float32Array; eye: Float32Array; tanFov: number }
  | { type: 'options'; value: ZeroOptions }
  | { type: 'time'; value: number }  // Unix timestamp (Date can't be transferred)
  | { type: 'uploadData'; layer: TWeatherLayer; timestep: string; slotIndex: number; slabIndex: number; data: Float32Array }
  | { type: 'activateSlots'; layer: TWeatherLayer; slot0: number; slot1: number; lerp: number; loadedPoints?: number }
  | { type: 'render' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'updatePalette'; layer: 'temp'; textureData: Uint8Array; min: number; max: number }
  | { type: 'cleanup' };

export type AuroraResponse =
  | { type: 'ready' }
  | { type: 'uploadComplete'; layer: TWeatherLayer; timestep: string; slotIndex: number }
  | { type: 'frameComplete'; timing?: { frame: number } }
  | { type: 'error'; message: string; fatal: boolean };

// ============================================================
// Worker state
// ============================================================

let renderer: GlobeRenderer | null = null;
let canvas: OffscreenCanvas | null = null;

// Camera state (received from main thread)
let cameraState = {
  viewProjInverse: new Float32Array(16),
  eye: new Float32Array([0, 0, 3]),
  tanFov: Math.tan(Math.PI / 8),
};

// Options state (received from main thread)
let currentOptions: ZeroOptions | null = null;

// Time state (received from main thread)
let currentTime = Date.now();

/**
 * Build uniforms from current state
 * Uses camera, options, and time from main thread
 */
function buildUniforms(): GlobeUniforms {
  const opts = currentOptions;
  const time = new Date(currentTime);

  return {
    // Camera (from main thread)
    viewProjInverse: cameraState.viewProjInverse,
    eyePosition: cameraState.eye,
    resolution: new Float32Array([canvas!.width, canvas!.height]),
    time: performance.now() / 1000,
    tanFov: cameraState.tanFov,
    // Sun (from time and options)
    sunOpacity: opts?.sun.enabled ? opts.sun.opacity : 1.0,
    sunDirection: getSunDirection(time),
    sunCoreRadius: 0.005,
    sunGlowRadius: 0.02,
    sunCoreColor: new Float32Array([1, 1, 0.9]),
    sunGlowColor: new Float32Array([1, 0.8, 0.4]),
    // Grid (from options)
    gridEnabled: opts?.grid.enabled ? opts.grid.opacity > 0.01 : false,
    gridOpacity: opts?.grid.enabled ? opts.grid.opacity : 0,
    gridFontSize: opts?.grid.fontSize ?? 12,
    gridLabelMaxRadius: 280,
    gridLineWidth: opts?.grid.lineWidth ?? 1,
    // Layers (from options)
    earthOpacity: opts?.earth.enabled ? opts.earth.opacity : 1.0,
    tempOpacity: opts?.temp.enabled ? opts.temp.opacity : 0,
    rainOpacity: opts?.rain.enabled ? opts.rain.opacity : 0,
    cloudsOpacity: opts?.clouds.enabled ? opts.clouds.opacity : 0,
    humidityOpacity: opts?.humidity.enabled ? opts.humidity.opacity : 0,
    windOpacity: opts?.wind.enabled ? opts.wind.opacity : 0,
    windLerp: 0,
    windAnimSpeed: opts?.wind.speed ?? 1,
    windState: { mode: 'loading', lerp: 0, time },
    pressureOpacity: opts?.pressure.enabled ? opts.pressure.opacity : 0,
    pressureColors: opts?.pressure.colors ?? PRESSURE_COLOR_DEFAULT,
    // Data state (TODO: receive from slot activation messages)
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

      // Initialize camera state from renderer's default camera
      const cam = renderer.camera;
      cameraState.viewProjInverse.set(cam.getViewProjInverse());
      cameraState.eye.set(cam.getEyePosition());
      cameraState.tanFov = cam.getTanFov();

      console.log('[Aurora] GlobeRenderer ready');
      self.postMessage({ type: 'ready' } satisfies AuroraResponse);
    }

    if (type === 'camera') {
      // Update camera state from main thread
      cameraState.viewProjInverse.set(e.data.viewProjInverse);
      cameraState.eye.set(e.data.eye);
      cameraState.tanFov = e.data.tanFov;
    }

    if (type === 'options') {
      currentOptions = e.data.value;
    }

    if (type === 'time') {
      currentTime = e.data.value;
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
      const uniforms = buildUniforms();
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

    if (type === 'uploadData') {
      const { layer, timestep, slotIndex, slabIndex, data } = e.data;
      // TODO: Write to LayerStore GPU buffers
      // For now, just acknowledge receipt
      console.log(`[Aurora] uploadData: ${layer} slot${slotIndex} slab${slabIndex} (${data.length} floats)`);

      self.postMessage({
        type: 'uploadComplete',
        layer,
        timestep,
        slotIndex,
      } satisfies AuroraResponse);
    }

    if (type === 'activateSlots') {
      const { layer, slot0, slot1, lerp } = e.data;
      // TODO: Rebind GPU buffers for rendering
      console.log(`[Aurora] activateSlots: ${layer} slots[${slot0},${slot1}] lerp=${lerp.toFixed(2)}`);

      // Update uniform state for this layer
      // This will be used in buildUniforms() for the next render
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
