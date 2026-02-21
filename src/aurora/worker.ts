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

import type { CameraConfig } from './camera';
import { GlobeRenderer, type GlobeUniforms } from './globe-renderer';
import { generateIsobarLevels } from '../layers/pressure/pressure-layer';
import { LayerStore } from './layer-store';
import type { ZeroOptions } from '../schemas/options.schema';
import type { TLayer } from '../config/types';
import { defaultConfig } from '../config/defaults';
import { getSunDirection } from '../utils/sun-position';
import { shaderComposer, activeParamBindings, type ComposedShaders } from './shader-composer';
import { LayerService, type LayerDeclaration } from '../services/layer/layer-service';
import type { PaletteId } from '../services/palette-service';
import { writeConfigUniforms, writeOptionUniforms } from './uniform-writer';

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
  // Initial palette configs per built-in layer: { layerIndex, slot, paletteId, range? }
  layerPalettes: Array<{ layerIndex: number; slot: number; paletteId: PaletteId; range?: [number, number] }>;
}

export interface AuroraConfig {
  cameraConfig: CameraConfig;
  timeslotsPerLayer: number;
  windLineCount: number;
  /** Param configs for buffer management (keyed by param name) */
  paramConfigs: Array<{ param: string; sizeMB: number }>;
  /** Built-in layer declarations (sent from main thread) */
  layers: LayerDeclaration[];
}

// ============================================================
// Message types
// ============================================================

export type AuroraRequest =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number; config: AuroraConfig; assets: AuroraAssets }
  | { type: 'options'; value: ZeroOptions }
  // Param-centric API
  | { type: 'uploadData'; param: string; slotIndex: number; data: Float32Array }
  | { type: 'activateSlots'; param: string; slot0: number; slot1: number; t0: number; t1: number; loadedPoints?: number }
  | { type: 'deactivateSlots'; param: string }
  | { type: 'render'; camera: { viewProj: Float32Array; viewProjInverse: Float32Array; eye: Float32Array; tanFov: number }; time: number }
  | { type: 'resize'; width: number; height: number }
  | { type: 'registerUserLayer'; layer: LayerDeclaration }
  | { type: 'unregisterUserLayer'; layerId: string }
  | { type: 'setUserLayerOptions'; layerIndex: number; enabled?: boolean; opacity?: number; paletteIndex?: number }
  | { type: 'updatePalette'; layer: string; paletteId: PaletteId; range?: [number, number] }
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

// Param stores for GPU buffer management (keyed by param name)
const paramStores = new Map<string, LayerStore>();


// Pipeline recreation queue — serializes concurrent recreatePipeline calls
let pipelineQueue: Promise<void> = Promise.resolve();

function queuePipelineRecreation(composedShaders: ComposedShaders): Promise<void> {
  // Recover from previous failures so the chain doesn't stay broken
  pipelineQueue = pipelineQueue.catch(() => {}).then(() => renderer!.recreatePipeline(composedShaders));
  return pipelineQueue;
}

// User layer state (opacity defaults to 1.0, enabled defaults to false when registered)
const userLayerOpacities = new Map<number, number>();  // index -> opacity
const userLayerEnabled = new Map<number, boolean>();   // index -> enabled

// Slot activation state per param (for uniform building)
interface SlotState {
  slot0: number;
  slot1: number;
  t0: number;  // Unix timestamp of slot0
  t1: number;  // Unix timestamp of slot1
  loadedPoints: number;
  dataReady: boolean;
}
const paramSlotStates = new Map<string, SlotState>();

// Dynamic param binding registry (built during init, matches ShaderComposer)
interface ParamBinding {
  index: number;          // 0, 1, 2, ...
  bindingSlot0: number;   // 50, 52, 54, ...
  bindingSlot1: number;   // 51, 53, 55, ...
}
const paramBindings = new Map<string, ParamBinding>();

// Find which layer uses a given param (from layerRegistry)
function findLayerForParam(param: string): string | undefined {
  if (!layerRegistry) return undefined;
  for (const layer of layerRegistry.getAll()) {
    if (layer.params?.some(ref => ref.param === param)) {
      return layer.id;
    }
  }
  return undefined;
}

// Get slot state for a layer (looks up first param's state)
function getLayerSlotState(layerId: string): SlotState {
  const params = layerRegistry!.get(layerId)!.params!;
  return paramSlotStates.get(params[0]!.param)!;
}

// Rebuild paramBindings from ShaderComposer's activeParamBindings (set during compose())
// Must match what the shader actually binds — only surface layer params
function rebuildParamBindings(): void {
  paramBindings.clear();
  for (const cfg of activeParamBindings) {
    paramBindings.set(cfg.param, {
      index: cfg.index,
      bindingSlot0: cfg.bindingSlot0,
      bindingSlot1: cfg.bindingSlot1,
    });
  }
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
let lastPressureMinute = -1;
let lastPressureSpacing = 4;
let lastSmoothing = 'light';

// Animated opacity state (smooth transitions ~100ms)
// Keyed by layer id, initialized from layer registry
const animatedOpacity = new Map<string, number>();
let lastFrameTime = 0;

/** Initialize animated opacity for all registered layers */
function initAnimatedOpacity(): void {
  if (!layerRegistry) return;
  for (const layer of layerRegistry.getAll()) {
    if (!animatedOpacity.has(layer.id)) {
      animatedOpacity.set(layer.id, 0);
    }
  }
}


/** Update animated opacities toward targets (exponential decay) */
function updateAnimatedOpacities(dt: number, currentTimeMs: number): void {
  const opts = currentOptions;
  if (!opts || !layerRegistry) return;

  const animMs = defaultConfig.render.opacityAnimationMs;
  const rate = 1000 / animMs;
  const factor = Math.min(1, dt * rate);

  // Check if data is ready AND current time is within data window
  // All params of the layer must be ready (not just the first) — prevents e.g.
  // rain rendering without wind data for advection
  const isDataReady = (layerId: string): boolean => {
    const params = layerRegistry!.get(layerId)!.params;
    if (!params) return false;
    const margin = 30 * 60 * 1000;  // 30 minutes
    for (const ref of params) {
      const state = paramSlotStates.get(ref.param);
      if (!state?.dataReady) return false;
      if (state.t0 === 0 && state.t1 === 0) return false;
      if (currentTimeMs < state.t0 - margin || currentTimeMs > state.t1 + margin) return false;
    }
    return true;
  };

  // Iterate all registered layers
  for (const layer of layerRegistry.getAll()) {
    let enabled: boolean;
    let opacity: number;

    if (layer.isBuiltIn) {
      // Built-in layers: get from Zod-validated options
      const layerOpts = opts[layer.id as TLayer];
      if (!layerOpts || !('enabled' in layerOpts)) continue;
      enabled = layerOpts.enabled;
      opacity = layerOpts.opacity;
    } else {
      // User layers: enabled and opacity from state maps (set on registration)
      const idx = layer.userLayerIndex!;
      enabled = userLayerEnabled.get(idx)!;
      opacity = userLayerOpacities.get(idx)!;
    }

    // Calculate target opacity
    let target = 0;
    if (enabled) {
      // Data layers (texture/geometry) require data ready check
      const needsData = layer.type === 'texture' || layer.type === 'geometry';
      if (!needsData || isDataReady(layer.id)) {
        target = opacity;
      }
    }

    // Animate toward target
    const current = animatedOpacity.get(layer.id)!;
    const newValue = current + (target - current) * factor;
    animatedOpacity.set(layer.id, newValue);
  }
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

/** Build per-layer opacity array from registry and animated values */
function buildLayerOpacities(): Float32Array {
  const layers = layerRegistry!.getAll().filter(l => l.isBuiltIn);
  const maxIndex = layers.reduce((max, l) => Math.max(max, l.index!), 0);
  const arr = new Float32Array(maxIndex + 1);
  for (const layer of layers) {
    arr[layer.index!] = animatedOpacity.get(layer.id) ?? 0;
  }
  return arr;
}

/** Build per-layer data ready array from registry and slot states.
 *  All params of a layer must be ready (e.g. rain needs wind + ptype + precip). */
function buildLayerDataReady(): boolean[] {
  const layers = layerRegistry!.getAll().filter(l => l.isBuiltIn);
  const maxIndex = layers.reduce((max, l) => Math.max(max, l.index!), 0);
  const arr = new Array<boolean>(maxIndex + 1).fill(false);
  for (const layer of layers) {
    if (layer.params?.length) {
      arr[layer.index!] = layer.params.every(ref => paramSlotStates.get(ref.param)?.dataReady);
    }
  }
  return arr;
}

/**
 * Build uniforms from render message state
 */
function buildUniforms(camera: CameraState, time: Date): GlobeUniforms {
  const opts = currentOptions!;

  return {
    // Camera (from render message)
    viewProj: camera.viewProj,
    viewProjInverse: camera.viewProjInverse,
    eyePosition: camera.eye,
    resolution: new Float32Array([canvas!.width, canvas!.height]),
    time: performance.now() / 1000,
    tanFov: camera.tanFov,
    sunDirection: getSunDirection(time),
    // Per-layer state built from registry (indexed by layer.index)
    layerOpacities: buildLayerOpacities(),
    layerDataReady: buildLayerDataReady(),
    // Wind/pressure have separate render passes with special state
    windLerp: computeLerp(getLayerSlotState('wind')!, time.getTime()),
    windAnimSpeed: opts.wind.speed,
    windState: {
      mode: getLayerSlotState('wind')!.dataReady ? 'pair' : 'loading',
      lerp: computeLerp(getLayerSlotState('wind')!, time.getTime()),
      time,
    },
    pressureColors: opts.pressure.colors,
    logoOpacity: opts.debug.showLogo && !isAnyLayerEnabled()
      ? 1 - Math.max(...animatedOpacity.values())
      : 0,
    rainBackFace: opts.rain.enabled && !opts.earth.enabled && !opts.temp.enabled ? 1 : 0,
  };
}

/** Check if any layer is enabled (for logo suppression) */
function isAnyLayerEnabled(): boolean {
  if (!currentOptions || !layerRegistry) return false;
  for (const layer of layerRegistry.getAll()) {
    if (layer.isBuiltIn) {
      const layerOpts = currentOptions[layer.id as TLayer];
      if (layerOpts && 'enabled' in layerOpts && layerOpts.enabled) return true;
    } else {
      const idx = layer.userLayerIndex!;
      if (userLayerEnabled.get(idx)) return true;
    }
  }
  return false;
}

// ============================================================
// Message Handlers
// ============================================================

async function handleInit(data: Extract<AuroraRequest, { type: 'init' }>): Promise<void> {
  if (!data.canvas) {
    console.warn('[Aurora] init called with null canvas, ignoring');
    return;
  }
  const { config, assets } = data;
  canvas = data.canvas;
  canvas.width = data.width;
  canvas.height = data.height;

  // Create and initialize renderer
  renderer = new GlobeRenderer(canvas, config.cameraConfig);

  // Register layers from main thread config
  layerRegistry = new LayerService();
  for (const layer of config.layers) {
    layerRegistry.registerBuiltIn(layer);
  }
  initAnimatedOpacity();  // Initialize opacity map for all layers
  const layers = layerRegistry.getAll();
  const composedShaders = shaderComposer.compose(layers);

  const graticuleLodLevels = layerRegistry.get('graticule')!.config!.lodLevels as Array<{ spacing: number; zoomInPx: number; zoomOutPx: number }>;
  const windRaw = layerRegistry.get('wind')!.config! as { snakeLength: { value: number }; lineWidth: { value: number }; segmentsPerLine: { value: number }; stepFactor: { value: number }; radius: { value: number } };
  const windCfg = {
    snakeLength: windRaw.snakeLength.value,
    lineWidth: windRaw.lineWidth.value,
    segmentsPerLine: windRaw.segmentsPerLine.value,
    stepFactor: windRaw.stepFactor.value,
    radius: windRaw.radius.value,
  };
  await renderer.initialize(
    config.timeslotsPerLayer,
    config.windLineCount,
    composedShaders,
    graticuleLodLevels,
    windCfg
  );

  // Upload assets
  renderer.createAtmosphereTextures(assets.atmosphereLUTs);
  await renderer.loadBasemap(assets.basemapFaces);
  await renderer.loadFontAtlas(assets.fontAtlas);
  await renderer.loadLogo(assets.logo);
  renderer.uploadGaussianLUTs(assets.gaussianLats, assets.ringOffsets);

  // Finalize renderer (creates bind groups)
  renderer.finalize();

  // Write declarative config uniforms for all layers
  const uniformView = renderer.getUniformView();
  for (const layer of layers) {
    if (layer.config) {
      writeConfigUniforms(uniformView, layer.config);
    }
  }

  // Create LayerStore instances for each param
  const device = renderer.getDevice();

  for (const paramCfg of config.paramConfigs) {
    const store = new LayerStore(device, {
      layerId: paramCfg.param,
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

  // Log unexpected device loss (ignore intentional destroy on cleanup)
  device.lost.then((info) => {
    if (info.reason !== 'destroyed') {
      console.error('[Aurora] GPU device lost:', info.reason, info.message);
    }
  });

  // Apply initial palette config for built-in layers
  for (const lp of assets.layerPalettes) {
    renderer.setLayerPalette(lp.layerIndex, lp.slot, lp.paletteId);
    if (lp.range) {
      renderer.setLayerPaletteRange(lp.layerIndex, lp.range[0], lp.range[1]);
    }
  }

  // Recreate pipeline with composed shaders (includes dynamic param bindings)
  const initLayers = layerRegistry.getAll();
  const initShaders = shaderComposer.compose(initLayers);
  await renderer.recreatePipeline(initShaders);

  // Build param binding registry from ShaderComposer (must be after compose())
  rebuildParamBindings();
  console.log('[Aurora] Using composed shaders for', initLayers.length, 'layers');

  self.postMessage({ type: 'ready' } satisfies AuroraResponse);
}

function handleOptions(data: Extract<AuroraRequest, { type: 'options' }>): void {
  const prevOptions = currentOptions;
  currentOptions = data.value;

  // Write option uniforms declaratively (graticuleFontSize, graticuleLineWidth, etc.)
  if (renderer) {
    writeOptionUniforms(renderer.getUniformView(), currentOptions);
  }

  // React to options that require buffer recreation
  if (prevOptions && currentOptions.wind.seedCount !== prevOptions.wind.seedCount) {
    renderer!.getWindLayer().setLineCount(currentOptions.wind.seedCount);
  }
}

function handleRender(data: Extract<AuroraRequest, { type: 'render' }>): void {
  if (!canvas || !renderer) return;
  const t0 = performance.now();
  const { camera, time } = data;
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

  // Check if smoothing changed
  const newSmoothing = opts.pressure.smoothing;
  if (newSmoothing !== lastSmoothing) {
    lastSmoothing = newSmoothing;
    needsContourRecompute = true;
  }

  // Recompute pressure contours when time, spacing, or smoothing changes
  const pressureState = getLayerSlotState('pressure');
  if (opts.pressure.enabled && pressureState?.dataReady) {
    const currentMinute = Math.floor(time / 60000);
    if (currentMinute !== lastPressureMinute || needsContourRecompute) {
      lastPressureMinute = currentMinute;
      // Map smoothing option to Chaikin iterations: none=0, light=1
      const smoothingMap: Record<string, number> = { none: 0, light: 1 };
      const smoothingIterations = smoothingMap[opts.pressure.smoothing]!;
      const lerp = computeLerp(pressureState, time);
      renderer!.runPressureContour(
        pressureState.slot0,
        pressureState.slot1,
        lerp,
        isobarLevels,
        smoothingIterations
      );
    }
  }

  const uniforms = buildUniforms(camera, new Date(time));

  renderer!.updateUniforms(uniforms);

  // Build animated user layer opacities (indexed by userLayerIndex)
  const animatedUserOpacities = new Map<number, number>();
  for (const layer of layerRegistry!.getAll()) {
    if (!layer.isBuiltIn && layer.userLayerIndex !== undefined) {
      animatedUserOpacities.set(layer.userLayerIndex, animatedOpacity.get(layer.id)!);
    }
  }
  renderer!.setUserLayerOpacities(animatedUserOpacities);

  // Update dynamic param state (lerp, ready flags, and dt)
  for (const [param, binding] of paramBindings) {
    const state = paramSlotStates.get(param);
    if (state) {
      const lerp = state.dataReady ? computeLerp(state, time) : -1;
      renderer!.setParamState(binding.index, lerp, state.dataReady);
      const dtSeconds = (state.t1 - state.t0) / 1000;
      renderer!.setParamDt(binding.index, dtSeconds);
    }
  }

  const passTimings = renderer!.render();

  // Compute memory stats from param stores
  let allocatedMB = 0;
  let totalSlabSizeMB = 0;
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

function handleResize(data: Extract<AuroraRequest, { type: 'resize' }>): void {
  if (!canvas || !renderer) return;
  canvas.width = data.width;
  canvas.height = data.height;
  renderer.resize(data.width, data.height);
}

function handleUploadData(data: Extract<AuroraRequest, { type: 'uploadData' }>): void {
  const { param, slotIndex, data: bufferData } = data;
  const store = paramStores.get(param);
  if (!store) {
    console.warn(`[Aurora] uploadData: unknown param ${param}`);
    return;
  }
  store.ensureSlotBuffers(slotIndex);
  store.writeToSlab(0, slotIndex, bufferData);
}

function handleActivateSlots(data: Extract<AuroraRequest, { type: 'activateSlots' }>): void {
  const { param, slot0, slot1, t0, t1, loadedPoints } = data;
  const store = paramStores.get(param);
  if (!store) {
    console.warn(`[Aurora] activateSlots: unknown param ${param}`);
    return;
  }

  // Check if slots actually changed - skip rebind if identical AND already bound
  const state = paramSlotStates.get(param);
  if (state && state.dataReady && state.slot0 === slot0 && state.slot1 === slot1 && state.t0 === t0 && state.t1 === t1) {
    return;
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

  // Determine which layer uses this param (built-in or custom)
  const layerId = findLayerForParam(param);
  if (!layerId) {
    console.warn(`[Aurora] activateSlots: no layer mapping for param ${param}`);
    return;
  }

  // Bind to renderer based on layer type
  // Wind and pressure have special handling; param bindings always checked separately
  // since a param can be used by both a built-in layer AND a custom layer
  if (layerId === 'wind') {
    // Multi-param layer: check if ALL params are ready
    const windParams = ['wind_u_component_10m', 'wind_v_component_10m'];
    const allReady = windParams.every(p => paramSlotStates.get(p)!.dataReady);
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
        }
      }
    }
  } else if (layerId === 'pressure') {
    const rawBuffer0 = store.getSlotBuffer(slot0, 0);
    if (rawBuffer0) {
      renderer!.triggerPressureRegrid(slot0, rawBuffer0);
    }
    if (slot1 !== slot0) {
      const rawBuffer1 = store.getSlotBuffer(slot1, 0);
      if (rawBuffer1) {
        renderer!.triggerPressureRegrid(slot1, rawBuffer1);
      }
    }
  }

  // Always bind to generic param bindings if this param is used by any custom layer
  if (paramBindings.has(param)) {
    const buffer0 = store.getSlotBuffer(slot0, 0);
    const buffer1 = store.getSlotBuffer(slot1, 0);
    if (buffer0 && buffer1) {
      renderer!.setParamBuffers(param, buffer0, buffer1);
    }
  }
}

function handleDeactivateSlots(data: Extract<AuroraRequest, { type: 'deactivateSlots' }>): void {
  const state = paramSlotStates.get(data.param);
  if (state) {
    state.dataReady = false;
  }
}

function handleRegisterUserLayer(data: Extract<AuroraRequest, { type: 'registerUserLayer' }>): void {
  const { layer } = data;
  if (!layerRegistry || !renderer) {
    console.warn('[Aurora] Cannot register user layer: not initialized');
    return;
  }

  layerRegistry.register(layer);
  animatedOpacity.set(layer.id, 0);  // Initialize opacity for animation

  if (layer.userLayerIndex !== undefined) {
    userLayerOpacities.set(layer.userLayerIndex, 1.0);
    userLayerEnabled.set(layer.userLayerIndex, false);  // Default disabled, set from sanitize
  }

  console.log(`[Aurora] Registered user layer: ${layer.id} (index ${layer.userLayerIndex})`);

  const layers = layerRegistry.getAll();
  const composedShaders = shaderComposer.compose(layers);
  queuePipelineRecreation(composedShaders)
    .then(() => {
      rebuildParamBindings();
      rebindAllParamBuffers();
      console.log('[Aurora] Pipeline recreated with', layers.length, 'layers');
      self.postMessage({ type: 'userLayerResult', layerId: layer.id, success: true });
    })
    .catch((err) => {
      layerRegistry!.unregister(layer.id);
      if (layer.userLayerIndex !== undefined) {
        userLayerOpacities.delete(layer.userLayerIndex);
        userLayerEnabled.delete(layer.userLayerIndex);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Aurora] Shader compilation failed:', message);
      self.postMessage({ type: 'userLayerResult', layerId: layer.id, success: false, error: message });
    });
}

function handleUnregisterUserLayer(data: Extract<AuroraRequest, { type: 'unregisterUserLayer' }>): void {
  const { layerId } = data;
  if (!layerRegistry || !renderer) {
    console.warn('[Aurora] Cannot unregister user layer: not initialized');
    return;
  }

  const layer = layerRegistry.get(layerId);
  const index = layer?.userLayerIndex;

  layerRegistry.unregister(layerId);

  if (index !== undefined) {
    userLayerOpacities.delete(index);
    userLayerEnabled.delete(index);
  }

  console.log(`[Aurora] Unregistered user layer: ${layerId}`);

  const layers = layerRegistry.getAll();
  const composedShaders = shaderComposer.compose(layers);
  queuePipelineRecreation(composedShaders)
    .then(() => {
      rebuildParamBindings();
      rebindAllParamBuffers();
      console.log('[Aurora] Pipeline recreated with', layers.length, 'layers');
    })
    .catch((err) => console.error('[Aurora] Pipeline recreation failed:', err));
}

function handleSetUserLayerOptions(data: Extract<AuroraRequest, { type: 'setUserLayerOptions' }>): void {
  if (data.enabled !== undefined) {
    userLayerEnabled.set(data.layerIndex, data.enabled);
  }
  if (data.opacity !== undefined) {
    userLayerOpacities.set(data.layerIndex, data.opacity);
  }
  if (data.paletteIndex !== undefined && renderer) {
    renderer.setUserLayerPaletteIndex(data.layerIndex, data.paletteIndex);
  }
}

function handleUpdatePalette(data: Extract<AuroraRequest, { type: 'updatePalette' }>): void {
  const { layer, paletteId, range } = data;
  if (!renderer || !layerRegistry) return;
  const layerIndex = layerRegistry.getLayerIndex(layer);
  if (isNaN(layerIndex)) return;
  renderer.setLayerPalette(layerIndex, 0, paletteId);
  if (range) {
    renderer.setLayerPaletteRange(layerIndex, range[0], range[1]);
  }
}

function handleCleanup(): void {
  for (const store of paramStores.values()) {
    store.dispose();
  }
  paramStores.clear();
  paramSlotStates.clear();

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

// ============================================================
// Message Dispatcher
// ============================================================

type MessageHandler<T extends AuroraRequest['type']> =
  (data: Extract<AuroraRequest, { type: T }>) => void | Promise<void>;

const handlers: { [K in AuroraRequest['type']]: MessageHandler<K> } = {
  init: handleInit,
  options: handleOptions,
  render: handleRender,
  resize: handleResize,
  uploadData: handleUploadData,
  activateSlots: handleActivateSlots,
  deactivateSlots: handleDeactivateSlots,
  registerUserLayer: handleRegisterUserLayer,
  unregisterUserLayer: handleUnregisterUserLayer,
  setUserLayerOptions: handleSetUserLayerOptions,
  updatePalette: handleUpdatePalette,
  cleanup: handleCleanup,
};

/** Type-safe dispatch: narrows handler+data by discriminant */
function dispatch<K extends AuroraRequest['type']>(msg: Extract<AuroraRequest, { type: K }>): void | Promise<void> {
  const handler = handlers[msg.type] as MessageHandler<K>;
  return handler(msg);
}

self.onmessage = async (e: MessageEvent<AuroraRequest>) => {
  try {
    await dispatch(e.data);
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      fatal: false,
    } satisfies AuroraResponse);
  }
};
