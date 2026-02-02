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
import type { TWeatherLayer, TWeatherTextureLayer, SlabConfig } from '../config/types';
import { GlobeRenderer, type GlobeUniforms } from '../render/globe-renderer';
import { LayerStore } from '../services/layer-store';
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
  /** Layer configs for LayerStore creation (only weather layers with slabs) */
  layerConfigs: Array<{ id: TWeatherLayer; slabs: SlabConfig[] }>;
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
  | { type: 'triggerPressureRegrid'; slotIndex: number }
  | { type: 'cleanup' };

export type AuroraResponse =
  | { type: 'ready' }
  | { type: 'uploadComplete'; layer: TWeatherLayer; timestep: string; slotIndex: number }
  | { type: 'frameComplete'; timing?: { frame: number } }
  | { type: 'deviceLost'; reason: string; message: string }
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

// Layer stores for GPU buffer management
const layerStores = new Map<TWeatherLayer, LayerStore>();

// Slot activation state per layer (for uniform building)
interface SlotState {
  slot0: number;
  slot1: number;
  lerp: number;
  loadedPoints: number;
  dataReady: boolean;
}
const slotStates = new Map<TWeatherLayer, SlotState>();

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
    windLerp: slotStates.get('wind')?.lerp ?? 0,
    windAnimSpeed: opts?.wind.speed ?? 1,
    windState: {
      mode: slotStates.get('wind')?.dataReady ? 'pair' : 'loading',
      lerp: slotStates.get('wind')?.lerp ?? 0,
      time,
    },
    pressureOpacity: opts?.pressure.enabled ? opts.pressure.opacity : 0,
    pressureColors: opts?.pressure.colors ?? PRESSURE_COLOR_DEFAULT,
    // Data state (from slot activation messages)
    tempDataReady: slotStates.get('temp')?.dataReady ?? false,
    rainDataReady: slotStates.get('rain')?.dataReady ?? false,
    cloudsDataReady: slotStates.get('clouds')?.dataReady ?? false,
    humidityDataReady: slotStates.get('humidity')?.dataReady ?? false,
    windDataReady: slotStates.get('wind')?.dataReady ?? false,
    tempLerp: slotStates.get('temp')?.lerp ?? 0,
    tempLoadedPoints: slotStates.get('temp')?.loadedPoints ?? 0,
    tempSlot0: slotStates.get('temp')?.slot0 ?? 0,
    tempSlot1: slotStates.get('temp')?.slot1 ?? 0,
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

      // Create LayerStore instances for each weather layer
      const device = renderer.getDevice();
      for (const layerCfg of config.layerConfigs) {
        const store = new LayerStore(device, {
          layerId: layerCfg.id,
          slabs: layerCfg.slabs,
          timeslots: config.timeslotsPerLayer,
        });
        store.initialize();
        layerStores.set(layerCfg.id, store);
        // Initialize slot state
        slotStates.set(layerCfg.id, {
          slot0: 0,
          slot1: 0,
          lerp: 0,
          loadedPoints: 0,
          dataReady: false,
        });
      }
      console.log(`[Aurora] Created ${layerStores.size} LayerStores`);

      // Set up device loss handling
      device.lost.then((info) => {
        console.error('[Aurora] GPU device lost:', info.reason, info.message);
        self.postMessage({
          type: 'deviceLost',
          reason: info.reason,
          message: info.message,
        } satisfies AuroraResponse);
      });

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
      const store = layerStores.get(layer);
      if (!store) {
        console.warn(`[Aurora] No LayerStore for ${layer}`);
        return;
      }

      // Ensure slot buffers exist
      store.ensureSlotBuffers(slotIndex);

      // Write data to GPU buffer
      store.writeToSlab(slabIndex, slotIndex, data);
      console.log(`[Aurora] uploadData: ${layer} slot${slotIndex} slab${slabIndex} (${data.length} floats)`);

      self.postMessage({
        type: 'uploadComplete',
        layer,
        timestep,
        slotIndex,
      } satisfies AuroraResponse);
    }

    if (type === 'activateSlots') {
      const { layer, slot0, slot1, lerp, loadedPoints } = e.data;
      const store = layerStores.get(layer);
      if (!store || !renderer) {
        console.warn(`[Aurora] activateSlots: missing store or renderer for ${layer}`);
        return;
      }

      // Update slot state for uniform building
      const state = slotStates.get(layer);
      if (state) {
        state.slot0 = slot0;
        state.slot1 = slot1;
        state.lerp = lerp;
        if (loadedPoints !== undefined) state.loadedPoints = loadedPoints;
        state.dataReady = true;
      }

      // Rebind GPU buffers based on layer type
      if (layer === 'temp' || layer === 'rain' || layer === 'clouds' || layer === 'humidity') {
        // Texture layers: single slab (index 0)
        const buffer0 = store.getSlotBuffer(slot0, 0);
        const buffer1 = store.getSlotBuffer(slot1, 0);
        if (buffer0 && buffer1) {
          renderer.setTextureLayerBuffers(layer as TWeatherTextureLayer, buffer0, buffer1);
        }
      } else if (layer === 'wind') {
        // Wind: 2 slabs (u=0, v=1)
        const u0 = store.getSlotBuffer(slot0, 0);
        const v0 = store.getSlotBuffer(slot0, 1);
        const u1 = store.getSlotBuffer(slot1, 0);
        const v1 = store.getSlotBuffer(slot1, 1);
        if (u0 && v0 && u1 && v1) {
          renderer.setWindLayerBuffers(u0, v0, u1, v1);
        }
      } else if (layer === 'pressure') {
        // Pressure: trigger regrid (raw=0, grid=1)
        const rawBuffer = store.getSlotBuffer(slot0, 0);
        if (rawBuffer) {
          renderer.triggerPressureRegrid(slot0, rawBuffer);
        }
      }

      console.log(`[Aurora] activateSlots: ${layer} slots[${slot0},${slot1}] lerp=${lerp.toFixed(2)}`);
    }

    if (type === 'updatePalette') {
      if (renderer) {
        renderer.updateTempPalette(e.data.textureData);
      }
    }

    if (type === 'triggerPressureRegrid') {
      const store = layerStores.get('pressure');
      if (renderer && store) {
        const rawBuffer = store.getSlotBuffer(e.data.slotIndex, 0);
        if (rawBuffer) {
          renderer.triggerPressureRegrid(e.data.slotIndex, rawBuffer);
        }
      }
    }

    if (type === 'cleanup') {
      // Dispose layer stores
      for (const store of layerStores.values()) {
        store.dispose();
      }
      layerStores.clear();
      slotStates.clear();

      // Get device before disposing renderer
      const device = renderer?.getDevice();

      renderer?.dispose();
      renderer = null;

      // Chrome 143+ WebGPU cleanup bug: must unconfigure context and destroy device
      if (canvas) {
        const ctx = canvas.getContext('webgpu');
        ctx?.unconfigure();
      }
      device?.destroy();
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
