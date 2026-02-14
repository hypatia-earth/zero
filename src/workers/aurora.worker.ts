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
import { generateIsobarLevels, type SmoothingAlgorithm } from '../layers/pressure/pressure-layer';
import { LayerStore } from '../services/layer-store';
import { PRESSURE_COLOR_DEFAULT, type ZeroOptions } from '../schemas/options.schema';
import { getSunDirection } from '../utils/sun-position';
import { shaderComposer } from '../render/shader-composer';
import { LayerService } from '../services/layer-service';
import { registerBuiltInLayers } from '../layers';

// ============================================================
// Palette types for temp layer
// ============================================================

interface PaletteStop {
  value: number | null;
  color: [number, number, number];
  alpha?: number;
}

interface PaletteData {
  name: string;
  unit: string;
  interpolate: boolean;
  stops: PaletteStop[];
}

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
  // Palette data for temp layer (loaded from JSON files)
  tempPalettes: Record<string, PaletteData>;
}

export interface AuroraConfig {
  cameraConfig: CameraConfig;
  timeslotsPerLayer: number;
  pressureResolution: 1 | 2;
  windLineCount: number;
  readyLayers: TWeatherLayer[];
  /** Layer configs for LayerStore creation (only weather layers with slabs) - DEPRECATED */
  layerConfigs: Array<{ id: TWeatherLayer; slabs: SlabConfig[] }>;
  /** Param configs for param-centric mode (USE_PARAM_SLOTS=true) */
  paramConfigs?: Array<{ param: string; sizeMB: number }>;
}

// ============================================================
// Message types
// ============================================================

export type AuroraRequest =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number; config: AuroraConfig; assets: AuroraAssets }
  | { type: 'options'; value: ZeroOptions }
  // Param-centric API (USE_PARAM_SLOTS=true)
  | { type: 'uploadData'; param: string; slotIndex: number; data: Float32Array }
  | { type: 'activateSlots'; param: string; slot0: number; slot1: number; t0: number; t1: number; loadedPoints?: number }
  | { type: 'deactivateSlots'; param: string }
  // Legacy layer-based API (USE_PARAM_SLOTS=false) - DEPRECATED
  | { type: 'uploadDataLegacy'; layer: TWeatherLayer; slotIndex: number; slabIndex: number; data: Float32Array }
  | { type: 'activateSlotsLegacy'; layer: TWeatherLayer; slot0: number; slot1: number; t0: number; t1: number; loadedPoints?: number }
  | { type: 'render'; camera: { viewProj: Float32Array; viewProjInverse: Float32Array; eye: Float32Array; tanFov: number }; time: number }
  | { type: 'resize'; width: number; height: number }
  | { type: 'registerUserLayer'; layer: import('../services/layer-service').LayerDeclaration }
  | { type: 'unregisterUserLayer'; layerId: string }
  | { type: 'setUserLayerOpacity'; layerIndex: number; opacity: number }
  | { type: 'cleanup' };

export type AuroraResponse =
  | { type: 'ready' }
  | { type: 'frameComplete'; timing: { frame: number; pass1: number; pass2: number; pass3: number }; memoryMB: { allocated: number; capacity: number } }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'userLayerResult'; layerId: string; success: boolean; error?: string };

// ============================================================
// Worker state
// ============================================================

let renderer: GlobeRenderer | null = null;
let canvas: OffscreenCanvas | null = null;

// Options state (received from main thread)
let currentOptions: ZeroOptions | null = null;

// Layer registry (for declarative mode)
let layerRegistry: LayerService | null = null;

// Layer stores for GPU buffer management (legacy, USE_PARAM_SLOTS=false)
const layerStores = new Map<TWeatherLayer, LayerStore>();

// Param stores for GPU buffer management (param-centric, USE_PARAM_SLOTS=true)
const paramStores = new Map<string, LayerStore>();

// Palette data (received at init)
let tempPalettes: Record<string, PaletteData> = {};

// User layer state (opacity defaults to 1.0 when registered)
const userLayerOpacities = new Map<number, number>();  // index -> opacity

// Slot activation state per layer (for uniform building)
interface SlotState {
  slot0: number;
  slot1: number;
  t0: number;  // Unix timestamp of slot0
  t1: number;  // Unix timestamp of slot1
  loadedPoints: number;
  dataReady: boolean;
}
// Legacy layer-keyed state (USE_PARAM_SLOTS=false)
const slotStates = new Map<TWeatherLayer, SlotState>();
// Param-keyed state (USE_PARAM_SLOTS=true)
const paramSlotStates = new Map<string, SlotState>();

// Dynamic param binding registry (built during init, matches ShaderComposer)
interface ParamBinding {
  index: number;          // 0, 1, 2, ...
  bindingSlot0: number;   // 50, 52, 54, ...
  bindingSlot1: number;   // 51, 53, 55, ...
}
const paramBindings = new Map<string, ParamBinding>();
const PARAM_BINDING_START = 50;  // Must match shader-composer.ts

// Find which layer uses a given param (from layerRegistry)
function findLayerForParam(param: string): string | undefined {
  if (!layerRegistry) return undefined;
  for (const layer of layerRegistry.getAll()) {
    if (layer.params?.includes(param)) {
      return layer.id;
    }
  }
  return undefined;
}

// Get params for a layer (from layerRegistry)
function getLayerParams(layerId: string): string[] {
  return layerRegistry?.get(layerId)?.params ?? [];
}

// Rebuild paramBindings after shader recomposition (indices may shift)
function rebuildParamBindings(layers: import('../services/layer-service').LayerDeclaration[]): void {
  const allParams = new Set<string>();
  for (const layer of layers) {
    layer.params?.forEach(p => allParams.add(p));
  }
  const sortedParams = [...allParams].sort();
  paramBindings.clear();
  sortedParams.forEach((param, idx) => {
    paramBindings.set(param, {
      index: idx,
      bindingSlot0: PARAM_BINDING_START + idx * 2,
      bindingSlot1: PARAM_BINDING_START + idx * 2 + 1,
    });
  });
}

// Rebind all active param buffers to renderer
function rebindAllParamBuffers(): void {
  if (!renderer) return;
  for (const [param, state] of paramSlotStates) {
    if (!state.dataReady) continue;
    const store = paramStores.get(param);
    if (!store) continue;
    const buffer0 = store.getSlotBuffer(state.slot0, 0);
    const buffer1 = store.getSlotBuffer(state.slot1, 0);
    if (buffer0 && buffer1) {
      renderer.setParamBuffers(param, buffer0, buffer1);
    }
  }
}

// Pressure contour state
let isobarLevels: number[] = generateIsobarLevels(4);  // Default 4 hPa spacing
const tempPaletteRange = new Float32Array([-40, 50]);  // Updated by updatePalette message
let lastPressureMinute = -1;
let lastPressureSpacing = 4;
let lastSmoothing = 'laplacian';
let lastSmoothingPasses = '1';

// Animated opacity state (smooth transitions ~100ms)
const animatedOpacity = {
  earth: 0,
  sun: 0,
  grid: 0,
  temp: 0,
  rain: 0,
  clouds: 0,
  humidity: 0,
  wind: 0,
  pressure: 0,
};
let lastFrameTime = 0;

/** Update animated opacities toward targets (exponential decay) */
function updateAnimatedOpacities(dt: number, currentTimeMs: number): void {
  const opts = currentOptions;
  if (!opts) return;

  const animMs = 100;  // ~100ms transitions
  const rate = 1000 / animMs;
  const factor = Math.min(1, dt * rate);

  // Check if data is ready AND current time is within data window
  const isReady = (layer: TWeatherLayer): boolean => {
    const state = slotStates.get(layer);
    if (!state?.dataReady) return false;
    // Check if current time is within slot time range (with some margin)
    // t0 and t1 are timestamps, allow some extrapolation margin (30 min)
    const margin = 30 * 60 * 1000;  // 30 minutes
    if (state.t0 === 0 && state.t1 === 0) return false;  // No timestamps set
    return currentTimeMs >= state.t0 - margin && currentTimeMs <= state.t1 + margin;
  };

  // Decoration layers: just enabled check
  animatedOpacity.earth += ((opts.earth.enabled ? opts.earth.opacity : 0) - animatedOpacity.earth) * factor;
  animatedOpacity.sun += ((opts.sun.enabled ? opts.sun.opacity : 0) - animatedOpacity.sun) * factor;
  animatedOpacity.grid += ((opts.grid.enabled ? opts.grid.opacity : 0) - animatedOpacity.grid) * factor;

  // Weather layers: enabled AND dataReady
  animatedOpacity.temp += (((opts.temp.enabled && isReady('temp')) ? opts.temp.opacity : 0) - animatedOpacity.temp) * factor;
  animatedOpacity.rain += (((opts.rain.enabled && isReady('rain')) ? opts.rain.opacity : 0) - animatedOpacity.rain) * factor;
  animatedOpacity.clouds += (((opts.clouds.enabled && isReady('clouds')) ? opts.clouds.opacity : 0) - animatedOpacity.clouds) * factor;
  animatedOpacity.humidity += (((opts.humidity.enabled && isReady('humidity')) ? opts.humidity.opacity : 0) - animatedOpacity.humidity) * factor;
  animatedOpacity.wind += (((opts.wind.enabled && isReady('wind')) ? opts.wind.opacity : 0) - animatedOpacity.wind) * factor;
  animatedOpacity.pressure += (((opts.pressure.enabled && isReady('pressure')) ? opts.pressure.opacity : 0) - animatedOpacity.pressure) * factor;
}

/** Compute lerp for a layer based on time and slot times */
function computeLerp(state: SlotState, timeMs: number): number {
  if (state.t0 === state.t1) return 0;  // Single timestep mode
  if (timeMs <= state.t0) return 0;
  if (timeMs >= state.t1) return 1;
  return (timeMs - state.t0) / (state.t1 - state.t0);
}

interface CameraState {
  viewProj: Float32Array;
  viewProjInverse: Float32Array;
  eye: Float32Array;
  tanFov: number;
}

/**
 * Build uniforms from render message state
 */
function buildUniforms(camera: CameraState, time: Date): GlobeUniforms {
  const opts = currentOptions;

  return {
    // Camera (from render message)
    viewProj: camera.viewProj,
    viewProjInverse: camera.viewProjInverse,
    eyePosition: camera.eye,
    resolution: new Float32Array([canvas!.width, canvas!.height]),
    time: performance.now() / 1000,
    tanFov: camera.tanFov,
    // Sun (animated opacity)
    sunOpacity: animatedOpacity.sun,
    sunDirection: getSunDirection(time),
    sunCoreRadius: 0.005,
    sunGlowRadius: 0.02,
    sunCoreColor: new Float32Array([1, 1, 0.9]),
    sunGlowColor: new Float32Array([1, 0.8, 0.4]),
    // Grid (animated opacity)
    gridEnabled: animatedOpacity.grid > 0.01,
    gridOpacity: animatedOpacity.grid,
    gridFontSize: opts?.grid.fontSize ?? 12,
    gridLabelMaxRadius: 280,
    gridLineWidth: opts?.grid.lineWidth ?? 1,
    // Layers (animated opacities)
    earthOpacity: animatedOpacity.earth,
    tempOpacity: animatedOpacity.temp,
    rainOpacity: animatedOpacity.rain,
    cloudsOpacity: animatedOpacity.clouds,
    humidityOpacity: animatedOpacity.humidity,
    windOpacity: animatedOpacity.wind,
    windLerp: slotStates.get('wind') ? computeLerp(slotStates.get('wind')!, time.getTime()) : 0,
    windAnimSpeed: opts?.wind.speed ?? 1,
    windState: {
      mode: slotStates.get('wind')?.dataReady ? 'pair' : 'loading',
      lerp: slotStates.get('wind') ? computeLerp(slotStates.get('wind')!, time.getTime()) : 0,
      time,
    },
    pressureOpacity: animatedOpacity.pressure,
    pressureColors: opts?.pressure.colors ?? PRESSURE_COLOR_DEFAULT,
    // Data state (from slot activation messages)
    tempDataReady: slotStates.get('temp')?.dataReady ?? false,
    rainDataReady: slotStates.get('rain')?.dataReady ?? false,
    cloudsDataReady: slotStates.get('clouds')?.dataReady ?? false,
    humidityDataReady: slotStates.get('humidity')?.dataReady ?? false,
    windDataReady: slotStates.get('wind')?.dataReady ?? false,
    tempLerp: slotStates.get('temp') ? computeLerp(slotStates.get('temp')!, time.getTime()) : 0,
    tempLoadedPoints: slotStates.get('temp')?.loadedPoints ?? 0,
    tempSlot0: slotStates.get('temp')?.slot0 ?? 0,
    tempSlot1: slotStates.get('temp')?.slot1 ?? 0,
    tempPaletteRange,
    logoOpacity: 0,
  };
}

// ============================================================
// Palette computation helpers
// ============================================================

function updateTempPaletteFromOptions(paletteName: string): void {
  const palette = tempPalettes[paletteName];
  if (!palette) {
    console.warn(`[Aurora] Unknown palette: ${paletteName}`);
    return;
  }

  const textureData = generatePaletteTexture(palette);
  const range = getPaletteRange(palette);

  renderer!.updateTempPalette(textureData);
  tempPaletteRange[0] = range.min;
  tempPaletteRange[1] = range.max;
}

function generatePaletteTexture(palette: PaletteData): Uint8Array {
  const stops = palette.stops.filter(s => s.value !== null);
  const values = stops.map(s => s.value!);
  const min = Math.min(...values);
  const max = Math.max(...values);

  const data = new Uint8Array(256 * 4);

  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const value = min + t * (max - min);
    const color = interpolatePaletteColor(palette, value, stops);

    data[i * 4 + 0] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = color[3];
  }

  return data;
}

function interpolatePaletteColor(
  palette: PaletteData,
  value: number,
  stops: PaletteStop[]
): [number, number, number, number] {
  if (stops.length === 0) return [0, 0, 0, 255];

  let lowerStop = stops[0]!;
  let upperStop = stops[stops.length - 1]!;

  for (let i = 0; i < stops.length - 1; i++) {
    const s1 = stops[i]!;
    const s2 = stops[i + 1]!;
    if (value >= s1.value! && value <= s2.value!) {
      lowerStop = s1;
      upperStop = s2;
      break;
    }
  }

  // Handle edge cases
  if (value <= lowerStop.value!) {
    return [...lowerStop.color, lowerStop.alpha ?? 255] as [number, number, number, number];
  }
  if (value >= upperStop.value!) {
    return [...upperStop.color, upperStop.alpha ?? 255] as [number, number, number, number];
  }

  // Interpolate
  const range = upperStop.value! - lowerStop.value!;
  const t = range > 0 ? (value - lowerStop.value!) / range : 0;

  if (!palette.interpolate) {
    // Discrete palette - use lower stop color
    return [...lowerStop.color, lowerStop.alpha ?? 255] as [number, number, number, number];
  }

  // Linear interpolation
  const r = Math.round(lowerStop.color[0] + t * (upperStop.color[0] - lowerStop.color[0]));
  const g = Math.round(lowerStop.color[1] + t * (upperStop.color[1] - lowerStop.color[1]));
  const b = Math.round(lowerStop.color[2] + t * (upperStop.color[2] - lowerStop.color[2]));
  const a = Math.round((lowerStop.alpha ?? 255) + t * ((upperStop.alpha ?? 255) - (lowerStop.alpha ?? 255)));

  return [r, g, b, a];
}

function getPaletteRange(palette: PaletteData): { min: number; max: number } {
  const values = palette.stops
    .map(s => s.value)
    .filter((v): v is number => v !== null);

  if (values.length === 0) return { min: 0, max: 1 };

  let min = Math.min(...values);
  let max = Math.max(...values);

  // Convert Fahrenheit to Celsius if needed
  if (palette.unit === 'F') {
    min = (min - 32) / 1.8;
    max = (max - 32) / 1.8;
  }

  return { min, max };
}

self.onmessage = async (e: MessageEvent<AuroraRequest>) => {
  const { type } = e.data;

  try {
    if (type === 'init') {
      const { config, assets } = e.data;
      canvas = e.data.canvas;
      canvas.width = e.data.width;
      canvas.height = e.data.height;

      // Create and initialize renderer
      renderer = new GlobeRenderer(canvas, config.cameraConfig);

      // Compose shaders dynamically from layer registry
      layerRegistry = new LayerService();
      registerBuiltInLayers(layerRegistry);
      const layers = layerRegistry.getAll();
      const composedShaders = shaderComposer.compose(layers);

      await renderer.initialize(
        config.timeslotsPerLayer,
        config.pressureResolution,
        config.windLineCount,
        composedShaders
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

      // Param-centric mode: create stores keyed by param name
      if (config.paramConfigs && config.paramConfigs.length > 0) {
        for (const paramCfg of config.paramConfigs) {
          const store = new LayerStore(device, {
            layerId: paramCfg.param as TWeatherLayer,  // LayerStore uses layerId internally
            slabs: [{ name: 'data', sizeMB: paramCfg.sizeMB }],
            timeslots: config.timeslotsPerLayer,
          });
          store.initialize();
          paramStores.set(paramCfg.param, store);
          paramSlotStates.set(paramCfg.param, {
            slot0: 0,
            slot1: 0,
            t0: 0,
            t1: 0,
            loadedPoints: 0,
            dataReady: false,
          });
        }

        // Build param binding registry (must match ShaderComposer order)
        const sortedParams = [...config.paramConfigs.map(c => c.param)].sort();
        sortedParams.forEach((param, idx) => {
          paramBindings.set(param, {
            index: idx,
            bindingSlot0: PARAM_BINDING_START + idx * 2,
            bindingSlot1: PARAM_BINDING_START + idx * 2 + 1,
          });
        });
      }

      // Legacy mode: create stores keyed by layer name
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
          t0: 0,
          t1: 0,
          loadedPoints: 0,
          dataReady: false,
        });
      }

      // Log unexpected device loss (ignore intentional destroy on cleanup)
      device.lost.then((info) => {
        if (info.reason !== 'destroyed') {
          console.error('[Aurora] GPU device lost:', info.reason, info.message);
        }
      });

      // Store palette data for later use
      tempPalettes = assets.tempPalettes;

      // Recreate pipeline with composed shaders (includes dynamic param bindings)
      const initLayers = layerRegistry.getAll();
      const initShaders = shaderComposer.compose(initLayers);
      await renderer.recreatePipeline(initShaders);
      console.log('[Aurora] Using composed shaders for', initLayers.length, 'layers');

      self.postMessage({ type: 'ready' } satisfies AuroraResponse);
    }

    if (type === 'options') {
      const prevOptions = currentOptions;
      currentOptions = e.data.value;

      // React to options that require buffer recreation
      if (prevOptions && currentOptions.wind.seedCount !== prevOptions.wind.seedCount) {
        renderer!.getWindLayer().setLineCount(currentOptions.wind.seedCount);
      }

      // Check if temp palette changed
      if (prevOptions && currentOptions.temp.palette !== prevOptions.temp.palette) {
        updateTempPaletteFromOptions(currentOptions.temp.palette);
      }
      // Also handle initial palette on first options message
      if (!prevOptions && currentOptions.temp.palette) {
        updateTempPaletteFromOptions(currentOptions.temp.palette);
      }
    }

    if (type === 'render') {
      const t0 = performance.now();
      const { camera, time } = e.data;
      const opts = currentOptions!;

      // Compute delta time and update animated opacities
      const dt = lastFrameTime > 0 ? (t0 - lastFrameTime) / 1000 : 0;
      lastFrameTime = t0;
      updateAnimatedOpacities(dt, time);

      // Update isobar spacing if changed
      const newSpacing = parseInt(opts.pressure.spacing, 10);
      let needsContourRecompute = false;
      if (newSpacing !== lastPressureSpacing) {
        lastPressureSpacing = newSpacing;
        isobarLevels = generateIsobarLevels(newSpacing);
        renderer!.setPressureLevelCount(isobarLevels.length);
        needsContourRecompute = true;
      }

      // Check if smoothing settings changed
      const newSmoothing = opts.pressure.smoothing;
      const newSmoothingPasses = opts.pressure.smoothingPasses;
      if (newSmoothing !== lastSmoothing || newSmoothingPasses !== lastSmoothingPasses) {
        lastSmoothing = newSmoothing;
        lastSmoothingPasses = newSmoothingPasses;
        needsContourRecompute = true;
      }

      // Recompute pressure contours when time, spacing, or smoothing changes
      const pressureState = slotStates.get('pressure');
      if (opts.pressure.enabled && pressureState?.dataReady) {
        const currentMinute = Math.floor(time / 60000);
        if (currentMinute !== lastPressureMinute || needsContourRecompute) {
          lastPressureMinute = currentMinute;
          const smoothing = opts.pressure.smoothing;
          const smoothingIterations = smoothing === 'none' ? 0 : parseInt(opts.pressure.smoothingPasses, 10);
          const smoothingAlgo: SmoothingAlgorithm = smoothing === 'none' ? 'laplacian' : smoothing;
          const lerp = computeLerp(pressureState, time);
          renderer!.runPressureContour(
            pressureState.slot0,
            pressureState.slot1,
            lerp,
            isobarLevels,
            smoothingIterations,
            smoothingAlgo
          );
        }
      }

      const uniforms = buildUniforms(camera, new Date(time));

      renderer!.updateUniforms(uniforms);
      renderer!.setUserLayerOpacities(userLayerOpacities);

      // Update dynamic param state (lerp and ready flags)
      for (const [param, binding] of paramBindings) {
        const state = paramSlotStates.get(param);
        if (state) {
          const lerp = state.dataReady ? computeLerp(state, time) : -1;
          renderer!.setParamState(binding.index, lerp, state.dataReady);
        }
      }

      const passTimings = renderer!.render();  // Returns GPU timestamp query results

      // Compute memory stats from layer stores and param stores
      // Allocated = actual buffers filled, Capacity = option × total slab sizes
      let allocatedMB = 0;
      let totalSlabSizeMB = 0;
      for (const store of layerStores.values()) {
        allocatedMB += store.getAllocatedCount() * store.timeslotSizeMB;
        totalSlabSizeMB += store.timeslotSizeMB;
      }
      for (const store of paramStores.values()) {
        allocatedMB += store.getAllocatedCount() * store.timeslotSizeMB;
        totalSlabSizeMB += store.timeslotSizeMB;
      }
      const timeslots = parseInt(currentOptions!.gpu.timeslotsPerLayer, 10);
      const capacityMB = totalSlabSizeMB * timeslots;

      const cpuTimeMs = performance.now() - t0;
      self.postMessage({
        type: 'frameComplete',
        timing: { frame: cpuTimeMs, pass1: passTimings.pass1Ms, pass2: passTimings.pass2Ms, pass3: passTimings.pass3Ms },
        memoryMB: { allocated: Math.round(allocatedMB), capacity: Math.round(capacityMB) },
      } satisfies AuroraResponse);
    }

    if (type === 'resize') {
      canvas!.width = e.data.width;
      canvas!.height = e.data.height;
      renderer!.resize(e.data.width, e.data.height);
    }

    // ============================================================
    // Param-centric API (USE_PARAM_SLOTS=true)
    // ============================================================

    if (type === 'uploadData') {
      const { param, slotIndex, data } = e.data;
      const store = paramStores.get(param);
      if (!store) {
        console.warn(`[Aurora] uploadData: unknown param ${param}`);
        return;
      }
      store.ensureSlotBuffers(slotIndex);
      store.writeToSlab(0, slotIndex, data);  // Always slab 0 in param-centric mode
    }

    if (type === 'activateSlots') {
      const { param, slot0, slot1, t0, t1, loadedPoints } = e.data;
      const store = paramStores.get(param);
      if (!store) {
        console.warn(`[Aurora] activateSlots: unknown param ${param}`);
        return;
      }

      // Check if slots actually changed - skip rebind if identical AND already bound
      const state = paramSlotStates.get(param);
      if (state && state.dataReady && state.slot0 === slot0 && state.slot1 === slot1 && state.t0 === t0 && state.t1 === t1) {
        return; // Already active with same slots
      }

      // Update param slot state
      if (state) {
        state.slot0 = slot0;
        state.slot1 = slot1;
        state.t0 = t0;
        state.t1 = t1;
        if (loadedPoints !== undefined) state.loadedPoints = loadedPoints;
        state.dataReady = true;
      }

      // Determine which renderer layer to bind
      const layer = findLayerForParam(param) as TWeatherLayer | undefined;
      if (!layer) {
        console.warn(`[Aurora] activateSlots: no layer mapping for param ${param}`);
        return;
      }

      // Also update legacy slotStates for uniform building (renderer still uses layer keys)
      const layerState = slotStates.get(layer);
      if (layerState) {
        layerState.slot0 = slot0;
        layerState.slot1 = slot1;
        layerState.t0 = t0;
        layerState.t1 = t1;
        if (loadedPoints !== undefined) layerState.loadedPoints = loadedPoints;
      }

      // Bind to renderer based on layer type
      if (layer === 'temp' || layer === 'rain' || layer === 'clouds' || layer === 'humidity') {
        // Single-param texture layers
        const buffer0 = store.getSlotBuffer(slot0, 0);
        const buffer1 = store.getSlotBuffer(slot1, 0);
        if (buffer0 && buffer1) {
          renderer!.setTextureLayerBuffers(layer as TWeatherTextureLayer, buffer0, buffer1);
          if (layerState) layerState.dataReady = true;

          // Also bind to dynamic param system
          const binding = paramBindings.get(param);
          if (binding) {
            renderer!.setParamBuffers(param, buffer0, buffer1);
          }
        }
      } else if (layer === 'wind') {
        // Multi-param layer: check if ALL params are ready
        const windParams = getLayerParams('wind');
        const allReady = windParams.every(p => paramSlotStates.get(p)?.dataReady);
        if (allReady) {
          const uStore = paramStores.get('wind_u_component_10m');
          const vStore = paramStores.get('wind_v_component_10m');
          const uState = paramSlotStates.get('wind_u_component_10m');
          const vState = paramSlotStates.get('wind_v_component_10m');
          if (uStore && vStore && uState && vState) {
            const u0 = uStore.getSlotBuffer(uState.slot0, 0);
            const v0 = vStore.getSlotBuffer(vState.slot0, 0);
            const u1 = uStore.getSlotBuffer(uState.slot1, 0);
            const v1 = vStore.getSlotBuffer(vState.slot1, 0);
            if (u0 && v0 && u1 && v1) {
              renderer!.setWindLayerBuffers(u0, v0, u1, v1);
              if (layerState) layerState.dataReady = true;
            }
          }
        }
      } else if (layer === 'pressure') {
        // Pressure: trigger regrid
        const rawBuffer = store.getSlotBuffer(slot0, 0);
        if (rawBuffer) {
          renderer!.triggerPressureRegrid(slot0, rawBuffer);
          if (layerState) layerState.dataReady = true;
        }
      }
    }

    if (type === 'deactivateSlots') {
      const { param } = e.data;

      // Clear param slot state
      const state = paramSlotStates.get(param);
      if (state) {
        state.dataReady = false;
      }

      // Also clear legacy slotStates for uniform building
      const layer = findLayerForParam(param) as TWeatherLayer | undefined;
      if (layer) {
        const layerState = slotStates.get(layer);
        if (layerState) {
          layerState.dataReady = false;
        }
      }
    }

    // ============================================================
    // Legacy layer-based API (USE_PARAM_SLOTS=false) - DEPRECATED
    // ============================================================

    if (type === 'uploadDataLegacy') {
      const { layer, slotIndex, slabIndex, data } = e.data;
      const store = layerStores.get(layer)!;
      store.ensureSlotBuffers(slotIndex);
      store.writeToSlab(slabIndex, slotIndex, data);
    }

    if (type === 'activateSlotsLegacy') {
      const { layer, slot0, slot1, t0, t1, loadedPoints } = e.data;
      const store = layerStores.get(layer)!;

      // Update slot state for uniform building
      const state = slotStates.get(layer);
      if (state) {
        state.slot0 = slot0;
        state.slot1 = slot1;
        state.t0 = t0;
        state.t1 = t1;
        if (loadedPoints !== undefined) state.loadedPoints = loadedPoints;
        state.dataReady = true;
      }

      // Rebind GPU buffers based on layer type
      if (layer === 'temp' || layer === 'rain' || layer === 'clouds' || layer === 'humidity') {
        // Texture layers: single slab (index 0)
        const buffer0 = store.getSlotBuffer(slot0, 0);
        const buffer1 = store.getSlotBuffer(slot1, 0);
        if (buffer0 && buffer1) {
          renderer!.setTextureLayerBuffers(layer as TWeatherTextureLayer, buffer0, buffer1);
        }
      } else if (layer === 'wind') {
        // Wind: 2 slabs (u=0, v=1)
        const u0 = store.getSlotBuffer(slot0, 0);
        const v0 = store.getSlotBuffer(slot0, 1);
        const u1 = store.getSlotBuffer(slot1, 0);
        const v1 = store.getSlotBuffer(slot1, 1);
        if (u0 && v0 && u1 && v1) {
          renderer!.setWindLayerBuffers(u0, v0, u1, v1);
        }
      } else if (layer === 'pressure') {
        // Pressure: trigger regrid (raw=0, grid=1)
        const rawBuffer = store.getSlotBuffer(slot0, 0);
        if (rawBuffer) {
          renderer!.triggerPressureRegrid(slot0, rawBuffer);
        }
      }
    }

    if (type === 'registerUserLayer') {
      const { layer } = e.data;
      if (!layerRegistry || !renderer) {
        console.warn('[Aurora] Cannot register user layer: not initialized');
        return;
      }

      // Add to registry
      layerRegistry.register(layer);

      // Set default opacity to 1.0
      if (layer.userLayerIndex !== undefined) {
        userLayerOpacities.set(layer.userLayerIndex, 1.0);
      }

      console.log(`[Aurora] Registered user layer: ${layer.id} (index ${layer.userLayerIndex})`);

      // Recompose shaders and recreate pipeline
      const layers = layerRegistry.getAll();
      const composedShaders = shaderComposer.compose(layers);
      renderer.recreatePipeline(composedShaders)
        .then(() => {
          // Rebuild paramBindings to match new shader bindings
          rebuildParamBindings(layers);
          // Rebind all active param buffers
          rebindAllParamBuffers();
          console.log('[Aurora] Pipeline recreated with', layers.length, 'layers');
          self.postMessage({ type: 'userLayerResult', layerId: layer.id, success: true });
        })
        .catch((err) => {
          // Rollback: remove the layer from registry
          layerRegistry!.unregister(layer.id);
          if (layer.userLayerIndex !== undefined) {
            userLayerOpacities.delete(layer.userLayerIndex);
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error('[Aurora] Shader compilation failed:', message);
          self.postMessage({ type: 'userLayerResult', layerId: layer.id, success: false, error: message });
        });
    }

    if (type === 'unregisterUserLayer') {
      const { layerId } = e.data;
      if (!layerRegistry || !renderer) {
        console.warn('[Aurora] Cannot unregister user layer: not initialized');
        return;
      }

      // Get index before removing
      const layer = layerRegistry.get(layerId);
      const index = layer?.userLayerIndex;

      // Remove from registry
      layerRegistry.unregister(layerId);

      // Remove opacity
      if (index !== undefined) {
        userLayerOpacities.delete(index);
      }

      console.log(`[Aurora] Unregistered user layer: ${layerId}`);

      // Recompose shaders and recreate pipeline
      const layers = layerRegistry.getAll();
      const composedShaders = shaderComposer.compose(layers);
      renderer.recreatePipeline(composedShaders)
        .then(() => {
          rebuildParamBindings(layers);
          rebindAllParamBuffers();
          console.log('[Aurora] Pipeline recreated with', layers.length, 'layers');
        })
        .catch((err) => console.error('[Aurora] Pipeline recreation failed:', err));
    }

    if (type === 'setUserLayerOpacity') {
      const { layerIndex, opacity } = e.data;
      userLayerOpacities.set(layerIndex, opacity);
    }

    if (type === 'cleanup') {
      // Dispose layer stores (legacy)
      for (const store of layerStores.values()) {
        store.dispose();
      }
      layerStores.clear();
      slotStates.clear();

      // Dispose param stores
      for (const store of paramStores.values()) {
        store.dispose();
      }
      paramStores.clear();
      paramSlotStates.clear();

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
