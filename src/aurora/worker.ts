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
import { LAYER_CATALOG } from './built_ins/catalog';
import { generateIsobarLevels } from './built_ins/pressure/pressure-layer';
import { LayerStore } from './layer-store';
import type { PressureColorOption } from './options/schema';
import type { TLayer } from '../config/types';
import { defaultConfig } from '../config/defaults';
import { getSunDirection } from './utils/sun-position';
import { shaderComposer, setModels, activeParamBindings, type ComposedShaders } from './shader-composer';
import { LayerService, isBuiltInLayer, type LayerDeclaration } from '../services/layer/layer-service';
import type { PaletteId } from '../services/palette-service';
import { writeConfigUniforms } from './uniform-writer';
import { U } from './globe-uniforms';
import { createCaptureHandler } from './capture';
import type { EngineOpts, GraticuleOpts, AuroraOptions as AuroraOptionsBlob } from './types/options';
import type { ModelSpec } from './types/model-spec';
import { AuroraOptions } from './options';

// ============================================================
// Asset types for worker transfer
// ============================================================

export interface AuroraAssets {
  // Atmosphere LUTs (raw binary data)
  atmosphereLUTs: {
    transmittance: ArrayBuffer;
    scattering: ArrayBuffer;
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
  // Cities layer assets
  cities: {
    data: ArrayBuffer;       // en.json raw bytes
    fontAtlas: ImageBitmap;  // inter-cities.png decoded
    metrics: ArrayBuffer;    // inter-regular.json raw bytes
  };
}

export interface AuroraConfig {
  cameraConfig: CameraConfig;
  /** Param configs for buffer management (keyed by param name) */
  paramConfigs: Array<{ param: string; sizeMB: number }>;
  /** Model registry — aurora indexes by `id` to size param buffers. */
  models: ModelSpec[];
  /** Built-in layer declarations (sent from main thread) */
  layers: LayerDeclaration[];
}

// ============================================================
// Message types
// ============================================================

export interface CameraSnapshot {
  viewProj: Float32Array;
  viewProjInverse: Float32Array;
  eye: Float32Array;
  tanFov: number;
}

export type AuroraRequest =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number; cssHeight: number; dpr: number; config: AuroraConfig; assets: AuroraAssets; auroraDefaults: AuroraOptionsBlob }
  // Sub-B Phase 5 typed setters — host dispatches via these for every
  // aurora-relevant option. The bulk legacy 'options' channel was retired
  // once every layer's UI bind-points migrated.
  | { type: 'setEngineOptions'; patch: Partial<EngineOpts> }
  | { type: 'setLayerOpacity'; id: string; value: number }
  // Phase E2 — enabled is host-owned (URL-backed) and not persisted in
  // aurora-db. Worker keeps an in-memory map and multiplies at render time.
  | { type: 'setLayerEnabled'; id: string; value: boolean }
  | { type: 'setLayerOptions'; id: string; opts: unknown }
  // Wipes aurora-db's persisted options blob and resets in-memory to defaults.
  // Host dispatches this when the user clicks Nuke; host first clears its own
  // zero-db keys, then sends this. Worker doesn't ack — message FIFO + sync
  // in-memory reset ensures any post-nuke setters apply to clean state.
  | { type: 'nukeOptions' }
  // Param-centric API
  | { type: 'uploadData'; param: string; slotIndex: number; data: Float32Array }
  | { type: 'activateSlots'; param: string; slot0: number; slot1: number; t0: number; t1: number; loadedPoints?: number }
  | { type: 'deactivateSlots'; param: string }
  | { type: 'render'; camera: CameraSnapshot; time: number }
  | { type: 'resize'; width: number; height: number; cssHeight: number; dpr: number }
  | { type: 'registerUserLayer'; layer: LayerDeclaration }
  | { type: 'unregisterUserLayer'; layerId: string }
  | { type: 'setUserLayerOptions'; layerIndex: number; enabled?: boolean; opacity?: number; paletteIndex?: number; paletteRange?: [number, number] }
  | { type: 'captureFrame' }
  | { type: 'recordBatch'; camera: CameraSnapshot; time: number; fixedDtMs: number; totalFrames: number }
  | { type: 'cleanup' };

export type AuroraResponse =
  | { type: 'ready'; options: AuroraOptionsBlob }
  | { type: 'frameComplete'; timing: { frame: number; pass1: number; pass2: number; pass3: number }; memoryMB: { allocated: number; capacity: number } }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'userLayerResult'; layerId: string; success: boolean; error?: string }
  | { type: 'exportFrame'; bitmap: ImageBitmap }
  | { type: 'recordProgress'; frameIndex: number }
  | { type: 'recordBatchComplete'; bitmaps: ImageBitmap[] }
  /** Echoed after every successful options mutation (update/clear); carries
   *  the full blob so the host's mirror signal stays authoritative. */
  | { type: 'optionsChanged'; options: AuroraOptionsBlob };

// ============================================================
// Worker state
// ============================================================

let renderer: GlobeRenderer | null = null;
let canvas: OffscreenCanvas | null = null;


// ============================================================
// Aurora options — single source of truth (Sub-B Phase 4 wired)
// ============================================================
//
// One in-memory canonical AuroraOptions blob, owned by `options`, which also
// persists itself to aurora-db. Worker reads via `options.read()` and mutates
// via `options.update*` from the typed-setter handlers. Per-layer renderer
// side-effects live in `applyLayerSideEffects` (called after the canonical
// mutation so it sees prev vs. next).

/** Per-layer host sub-shapes used as cast targets at access sites. The full
 *  WindOpts/PressureOpts in `aurora/types/options` use different field names
 *  (Phase 9 cleanup); these reflect what the host actually drives today. */
type GraticuleHostOpts = Pick<GraticuleOpts, 'fontSize' | 'lineWidth'>;
type CitiesHostOpts = { color: [number, number, number] };
type TempHostOpts = { palette: PaletteId };
type WindHostOpts = { seedCount: number; speed: number };
type PressureHostOpts = {
  spacing: number;       // hPa (parsed from string at the adapter)
  smoothing: 'none' | 'light';
  colors: PressureColorOption;
};
type RainHostOpts = { animated: boolean };

// Aurora-db wrapper. Constructed in `handleInit` once main thread sends
// schema-derived defaults via the init message — keeps Zod out of the
// worker bundle. Definite-assignment assertion: every helper that touches
// `options` runs strictly after init.
let options!: AuroraOptions;

function getWindOpts(): WindHostOpts { return options.read().layers.wind!.opts as WindHostOpts; }
function getPressureOpts(): PressureHostOpts { return options.read().layers.pressure!.opts as PressureHostOpts; }
function getRainOpts(): RainHostOpts { return options.read().layers.rain!.opts as RainHostOpts; }

/** Renderer side-effects when a layer's typed-setter mutates the blob. Called
 *  after the canonical mutation, with prev for diff-aware effects (wind seed
 *  buffer recreation only fires when seedCount actually changes). */
function applyLayerSideEffects(id: string, prev: { opts: unknown } | undefined, next: { opts: unknown }): void {
  if (!renderer) return;
  switch (id) {
    case 'graticule': {
      const o = next.opts as GraticuleHostOpts;
      renderer.setGraticuleOptions(o.fontSize, o.lineWidth);
      break;
    }
    case 'cities': {
      const o = next.opts as CitiesHostOpts;
      const view = renderer.getUniformView();
      view.setFloat32(U.cityColorR, o.color[0], true);
      view.setFloat32(U.cityColorG, o.color[1], true);
      view.setFloat32(U.cityColorB, o.color[2], true);
      break;
    }
    case 'wind': {
      const newOpts = next.opts as WindHostOpts;
      const prevOpts = prev?.opts as WindHostOpts | undefined;
      if (newOpts.seedCount !== prevOpts?.seedCount) {
        renderer.setWindSeedCount(newOpts.seedCount);
      }
      break;
    }
    case 'temp': {
      // Palette is aurora-owned post-F-B. Range is layer-specific knowledge
      // (was hardcoded in host's gpu-init asset block); reapply on first
      // call. Subsequent calls only need to update the palette ID.
      const newOpts = next.opts as TempHostOpts;
      const prevOpts = prev?.opts as TempHostOpts | undefined;
      if (!layerRegistry) break;
      const layerIndex = layerRegistry.getLayerIndex('temp');
      if (isNaN(layerIndex)) break;
      renderer.setLayerPalette(layerIndex, 0, newOpts.palette);
      if (prevOpts === undefined) {
        renderer.setLayerPaletteRange(layerIndex, -40, 50);
      }
      break;
    }
    // pressure / rain: read at render time, no immediate side-effect needed.
  }
}

// Phase E2 — host-owned `enabled` per built-in layer. Not persisted in
// aurora-db (URL is the source of truth). Defaults to true on miss so a
// pre-Phase-E2 worker (no setLayerEnabled dispatched) renders as before.
const layerEnabled = new Map<string, boolean>();

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
  gridPoints: number;     // grid point count for combined buffer offset
  bindingType: 'storage' | 'texture';
}
const paramBindings = new Map<string, ParamBinding>();

// Combined param buffers (t0+t1 packed into single GPU buffer per param)
const paramCombinedBuffers = new Map<string, GPUBuffer>();

// Combined param textures (t0+t1 packed vertically into single GPU texture per texture-backed param)
const paramCombinedTextures = new Map<string, GPUTexture>();

/** Texture width for texture-backed params (4096 texels = one row) */
const PARAM_TEX_WIDTH = 4096;

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
function getLayerSlotState(layerId: TLayer ): SlotState {
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
      gridPoints: cfg.gridPoints,
      bindingType: cfg.bindingType,
    });
  }
}

/** Write paramSize uniforms for all active param bindings */
function writeParamSizes(): void {
  if (!renderer) return;
  for (const [, binding] of paramBindings) {
    renderer.setParamSize(binding.index, binding.gridPoints);
  }
}

/** Wind u+v pack pairs: v is packed into u's buffer as [u_t0, v_t0, u_t1, v_t1] */
/** Pack pairs: secondary → primary. Buffer layout: [primary_t0, secondary_t0, primary_t1, secondary_t1] */
const PACK_PAIRS: Record<string, string> = {
  wind_v_component_1000hPa: 'wind_u_component_1000hPa',
  snowfall_water_equivalent: 'precipitation',
};

/** Create/update combined buffer/texture for a param and bind to renderer via GPU copy */
function updateCombinedParam(param: string, slot0: number, slot1: number): void {
  if (!renderer) return;
  const binding = paramBindings.get(param);
  if (!binding) return;

  // If this param is a packed secondary, update the primary's combined buffer instead
  const primaryParam = PACK_PAIRS[param];
  if (primaryParam) {
    const primaryState = paramSlotStates.get(primaryParam);
    if (primaryState?.dataReady) {
      updatePackedCombinedBuffer(primaryParam, primaryState.slot0, primaryState.slot1, param, slot0, slot1);
    }
    return;
  }

  // If this param is a pack primary, check if partner is ready for packed buffer
  const partnerParam = Object.entries(PACK_PAIRS).find(([, primary]) => primary === param)?.[0];
  if (partnerParam) {
    const partnerState = paramSlotStates.get(partnerParam);
    if (partnerState?.dataReady) {
      updatePackedCombinedBuffer(param, slot0, slot1, partnerParam, partnerState.slot0, partnerState.slot1);
      return;
    }
    // Partner not ready yet — fall through to build primary-only buffer (partial, will be rebuilt when partner arrives)
  }

  // Route to texture or buffer path based on binding type
  if (binding.bindingType === 'texture') {
    updateCombinedTexture(param, slot0, slot1, binding);
  } else {
    updateCombinedBuffer(param, slot0, slot1, binding);
  }
}

/** Create/update combined storage buffer [t0, t1] for a storage-backed param */
function updateCombinedBuffer(param: string, slot0: number, slot1: number, binding: ParamBinding): void {
  const store = paramStores.get(param);
  if (!store || !renderer) return;

  const buffer0 = store.getSlotBuffer(slot0, 0);
  const buffer1 = store.getSlotBuffer(slot1, 0);
  if (!buffer0 || !buffer1) return;

  const dataBytes = binding.gridPoints * 4;
  const combinedSize = dataBytes * 2;
  const device = renderer.getDevice();

  // Create or reuse combined buffer
  let combined = paramCombinedBuffers.get(param);
  if (!combined || combined.size !== combinedSize) {
    combined?.destroy();
    combined = device.createBuffer({
      size: combinedSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: `combined-${param}`,
    });
    paramCombinedBuffers.set(param, combined);
  }

  // GPU copy: t0 at offset 0, t1 at offset dataBytes
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer0, 0, combined, 0, dataBytes);
  encoder.copyBufferToBuffer(buffer1, 0, combined, dataBytes, dataBytes);
  device.queue.submit([encoder.finish()]);

  renderer.setParamBuffer(param, combined);
}

/** Create/update combined texture (t0+t1 packed vertically) for a texture-backed param */
function updateCombinedTexture(param: string, slot0: number, slot1: number, binding: ParamBinding): void {
  const store = paramStores.get(param);
  if (!store || !renderer) return;

  const buffer0 = store.getSlotBuffer(slot0, 0);
  const buffer1 = store.getSlotBuffer(slot1, 0);
  if (!buffer0 || !buffer1) return;

  const gp = binding.gridPoints;
  const texHeight = Math.ceil(gp / PARAM_TEX_WIDTH);
  const combinedHeight = texHeight * 2;  // t0 + t1 stacked vertically
  const device = renderer.getDevice();

  // Create or reuse combined texture
  let combined = paramCombinedTextures.get(param);
  if (!combined || combined.height !== combinedHeight) {
    combined?.destroy();
    combined = device.createTexture({
      size: [PARAM_TEX_WIDTH, combinedHeight],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: `combined-tex-${param}`,
    });
    paramCombinedTextures.set(param, combined);
  }

  // Copy from slot buffers to texture rows via copyBufferToTexture
  const bytesPerRow = PARAM_TEX_WIDTH * 4;
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToTexture(
    { buffer: buffer0, bytesPerRow, rowsPerImage: texHeight },
    { texture: combined, origin: [0, 0, 0] },
    { width: PARAM_TEX_WIDTH, height: texHeight },
  );
  encoder.copyBufferToTexture(
    { buffer: buffer1, bytesPerRow, rowsPerImage: texHeight },
    { texture: combined, origin: [0, texHeight, 0] },
    { width: PARAM_TEX_WIDTH, height: texHeight },
  );
  device.queue.submit([encoder.finish()]);

  renderer.setParamTexture(param, combined);
}

/** Build packed wind buffer: [u_t0, v_t0, u_t1, v_t1] for a u+v pair */
function updatePackedCombinedBuffer(
  uParam: string, uSlot0: number, uSlot1: number,
  vParam: string, vSlot0: number, vSlot1: number,
): void {
  if (!renderer) return;
  const uBinding = paramBindings.get(uParam);
  if (!uBinding) return;

  const uStore = paramStores.get(uParam);
  const vStore = paramStores.get(vParam);
  if (!uStore || !vStore) return;

  const uBuf0 = uStore.getSlotBuffer(uSlot0, 0);
  const uBuf1 = uStore.getSlotBuffer(uSlot1, 0);
  const vBuf0 = vStore.getSlotBuffer(vSlot0, 0);
  const vBuf1 = vStore.getSlotBuffer(vSlot1, 0);
  if (!uBuf0 || !uBuf1 || !vBuf0 || !vBuf1) return;

  const dataBytes = uBinding.gridPoints * 4;
  const combinedSize = dataBytes * 4;  // u_t0 + v_t0 + u_t1 + v_t1
  const device = renderer.getDevice();

  let combined = paramCombinedBuffers.get(uParam);
  if (!combined || combined.size !== combinedSize) {
    combined?.destroy();
    combined = device.createBuffer({
      size: combinedSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: `combined-wind-${uParam}`,
    });
    paramCombinedBuffers.set(uParam, combined);
  }

  // GPU copy: [u_t0, v_t0, u_t1, v_t1]
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(uBuf0, 0, combined, 0, dataBytes);
  encoder.copyBufferToBuffer(vBuf0, 0, combined, dataBytes, dataBytes);
  encoder.copyBufferToBuffer(uBuf1, 0, combined, dataBytes * 2, dataBytes);
  encoder.copyBufferToBuffer(vBuf1, 0, combined, dataBytes * 3, dataBytes);
  device.queue.submit([encoder.finish()]);

  renderer.setParamBuffer(uParam, combined);
}

// Rebind all active param buffers to renderer (after pipeline recreation)
function rebindAllParamBuffers(): void {
  if (!renderer) return;
  for (const [param, state] of paramSlotStates) {
    if (!state.dataReady) continue;
    updateCombinedParam(param, state.slot0, state.slot1);
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

/** A built-in layer counts as visible for cross-layer decisions (logo overlay,
 *  rain backface, pressure compute-skip) when its user-intended target opacity
 *  is non-zero. The host pre-multiplies enabled→opacity-or-zero into the layer
 *  entry's `opacity` via setLayerOpacity, so this derives uniformly. */
function isLayerEnabled(id: string): boolean {
  return (options.read().layers[id]?.opacity ?? 0) > 0;
}


/** Update animated opacities toward targets (exponential decay) */
function updateAnimatedOpacities(dt: number, currentTimeMs: number): void {
  if (!layerRegistry) return;

  const animMs = defaultConfig.render.opacityAnimationMs;
  const rate = 1000 / animMs;
  const factor = Math.min(1, dt * rate);

  // Check if data is ready AND current time is within data window
  // All params of the layer must be ready (not just the first) — prevents e.g.
  // rain rendering without wind data for advection
  const isDataReady = (layerId: TLayer ): boolean => {
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
    // Source the pre-gating user-intended opacity. For built-ins it comes from
    // options.layers[id].opacity (driven by setLayerOpacity); for user layers
    // it stays on the dedicated user-layer state maps.
    let userTarget: number;
    if (isBuiltInLayer(layer)) {
      const entry = options.read().layers[layer.id];
      if (!entry) continue;  // before first options/setter delivery
      // Phase E2 — built-ins now follow the user-layer pattern: stored
      // opacity is the user's *intended* value; multiply by the host-
      // owned `enabled` flag at render time.
      const enabled = layerEnabled.get(layer.id) ?? true;
      userTarget = enabled ? entry.opacity : 0;
    } else {
      const idx = layer.userLayerIndex!;
      const enabled = userLayerEnabled.get(idx)!;
      userTarget = enabled ? userLayerOpacities.get(idx)! : 0;
    }

    // Apply data-ready / data-window gate uniformly. Data layers (texture/
    // geometry) require valid data; non-data layers (graticule, cities, sun)
    // bypass the gate.
    let target = 0;
    if (userTarget > 0) {
      const needsData = layer.type === 'texture' || layer.type === 'geometry';
      if (!needsData || isDataReady(layer.id)) {
        target = userTarget;
      }
    }

    // Animate toward target
    const current = animatedOpacity.get(layer.id)!;
    const newValue = current + (target - current) * factor;
    animatedOpacity.set(layer.id, newValue);
  }
}

/** Compute lerp for a layer based on time and slot times.
 *  Returns -1 if time is outside the active pair (stale slots). */
function computeLerp(state: SlotState, timeMs: number): number {
  if (state.t0 === state.t1) {
    // Single timestep: valid only at exact millisecond match
    return timeMs === state.t0 ? 0 : -1;
  }
  if (timeMs < state.t0 || timeMs > state.t1) return -1;  // Outside pair range
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
 * Build uniforms from render message state. Reads from the canonical
 * `options.read()` blob — engine fields and per-layer opts both live there.
 */
function buildUniforms(camera: CameraState, time: Date): GlobeUniforms {
  const engine = options.read().engine;
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
    windAnimSpeed: getWindOpts().speed,
    windState: {
      mode: getLayerSlotState('wind')!.dataReady ? 'pair' : 'loading',
      lerp: computeLerp(getLayerSlotState('wind')!, time.getTime()),
      time,
    },
    pressureColors: getPressureOpts().colors,
    logoOpacity: engine.showLogo && !isAnyLayerEnabled()
      ? 1 - Math.max(...animatedOpacity.values())
      : 0,
    backfaceKiller: LAYER_CATALOG.some(e => e.backfaceKiller && isLayerEnabled(e.id)) ? 1 : 0,
    rainAnimated: getRainOpts().animated,
  };
}

/** Check if any layer is enabled (for logo suppression) */
function isAnyLayerEnabled(): boolean {
  if (!layerRegistry) return false;
  for (const layer of layerRegistry.getAll()) {
    if (isBuiltInLayer(layer)) {
      if (isLayerEnabled(layer.id)) return true;
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

  // F-A — schema-derived defaults arrive in the init message; main thread
  // computes them via `auroraOptionsSchema.parse({})` so this worker bundle
  // never touches Zod. Construct AuroraOptions now, then run its IDB merge:
  // `defaults < seeds < persisted`. Post-F-B, no host seeds — aurora-db is
  // authoritative for all engine + layer fields.
  options = new AuroraOptions({ dbName: 'aurora-db', defaults: data.auroraDefaults });
  await options.init({});

  // Create and initialize renderer
  // Pass dpr from main thread — workers may not have devicePixelRatio (Chrome)
  // or report incorrect values, causing graticule LoD mismatch across browsers
  renderer = new GlobeRenderer(canvas, config.cameraConfig, data.dpr, data.cssHeight);

  // Register layers from main thread config
  layerRegistry = new LayerService();
  for (const layer of config.layers) {
    layerRegistry.registerBuiltIn(layer);
  }
  initAnimatedOpacity();  // Initialize opacity map for all layers

  // Aurora-internal model registry — host injects via init.
  setModels(config.models);

  const layers = layerRegistry.getAll();
  const composedShaders = await shaderComposer.compose(layers);

  // Aurora-db is authoritative for buffer-sizing options post-F-B.
  const initEngine = options.read().engine;
  const initWindSeedCount = (options.read().layers.wind!.opts as WindHostOpts).seedCount;

  await renderer.initialize(
    initEngine.timeslotsPerLayer,
    initWindSeedCount,
    composedShaders,
  );

  // Upload assets
  renderer.createAtmosphereTextures(assets.atmosphereLUTs);
  await renderer.loadBasemap(assets.basemapFaces);
  await renderer.loadFontAtlas(assets.fontAtlas);
  await renderer.loadLogo(assets.logo);
  await renderer.loadCitiesFontAtlas(assets.cities.fontAtlas);
  renderer.uploadGaussianLUTs(assets.gaussianLats, assets.ringOffsets);

  // Initialize cities layer (LoD levels live in aurora's CITIES_DEFAULT_LOD_LEVELS)
  renderer.initCities(assets.cities.data, assets.cities.metrics);

  // Finalize renderer (creates bind groups)
  renderer.finalize();

  // Self-apply each layer's persisted/default options to the renderer.
  // Pre-Phase-C the host's init-dispatch sweep covered this for every
  // built-in; once a layer migrates to the catalog/adapter path, the host
  // no longer dispatches at init, so the worker has to push descriptor
  // defaults (or persisted values) into the renderer itself. Idempotent
  // for layers the host still re-dispatches at init (Phase D layers).
  for (const [id, entry] of Object.entries(options.read().layers)) {
    applyLayerSideEffects(id, undefined, entry);
  }

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
      timeslots: initEngine.timeslotsPerLayer,
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
  const initShaders = await shaderComposer.compose(initLayers);
  await renderer.recreatePipeline(initShaders);

  // Build param binding registry from ShaderComposer (must be after compose())
  rebuildParamBindings();
  writeParamSizes();
  if (initLayers.length === 0) {
    console.error('[Aurora] No layers registered for shader composition');
  }

  self.postMessage({ type: 'ready', options: options.read() } satisfies AuroraResponse);
}

/** Broadcast the canonical options blob after any successful mutation.
 *  Phase B host mirror reads from this; round-trip is intentional so the
 *  optimistic adapter writes are reconciled against persisted truth. */
function postOptionsChanged(): void {
  self.postMessage({ type: 'optionsChanged', options: options.read() } satisfies AuroraResponse);
}

async function handleRender(data: Extract<AuroraRequest, { type: 'render' }>): Promise<void> {
  if (!canvas || !renderer) return;
  const t0 = performance.now();
  const { camera, time } = data;

  // Compute delta time and update animated opacities
  const dt = lastFrameTime > 0 ? (t0 - lastFrameTime) / 1000 : 0;
  lastFrameTime = t0;
  updateAnimatedOpacities(dt, time);

  // Update isobar spacing if changed
  const pressureOpts = getPressureOpts();
  const newSpacing = pressureOpts.spacing;
  let needsContourRecompute = false;
  if (newSpacing !== lastPressureSpacing) {
    lastPressureSpacing = newSpacing;
    isobarLevels = generateIsobarLevels(newSpacing);
    renderer!.setPressureLevelCount(isobarLevels.length);
    needsContourRecompute = true;
  }

  // Check if smoothing changed
  const newSmoothing = pressureOpts.smoothing;
  if (newSmoothing !== lastSmoothing) {
    lastSmoothing = newSmoothing;
    needsContourRecompute = true;
  }

  // Recompute pressure contours when time, spacing, or smoothing changes.
  const pressureState = getLayerSlotState('pressure');
  if (isLayerEnabled('pressure') && pressureState?.dataReady) {
    const currentMinute = Math.floor(time / 60000);
    if (currentMinute !== lastPressureMinute || needsContourRecompute) {
      lastPressureMinute = currentMinute;
      // Map smoothing option to Chaikin iterations: none=0, light=1
      const smoothingMap: Record<string, number> = { none: 0, light: 1 };
      const smoothingIterations = smoothingMap[pressureOpts.smoothing]!;
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
      renderer!.setParamState(binding.index, lerp, state.dataReady && lerp >= 0);
      const dtSeconds = (state.t1 - state.t0) / 1000;
      renderer!.setParamDt(binding.index, dtSeconds);
    }
  }

  // DO NOT CHANGE THIS ORDER: uploadUniforms must come after setParamState/setParamDt.
  // Moving the upload before param writes causes lerp values to lag one frame behind,
  // producing a 1-2 frame flash of wrong timestep data on every time transition.
  renderer!.uploadUniforms();
  const passTimings = renderer!.render();

  // Capture frame if pending (right after render, before next frame overwrites)
  await flushCaptureFrame();

  // Compute memory stats from param stores
  let allocatedMB = 0;
  let totalSlabSizeMB = 0;
  for (const store of paramStores.values()) {
    allocatedMB += store.getAllocatedCount() * store.timeslotSizeMB;
    totalSlabSizeMB += store.timeslotSizeMB;
  }
  const capacityMB = totalSlabSizeMB * options.read().engine.timeslotsPerLayer;

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
  renderer.dpr = data.dpr;
  renderer.cssHeight = data.cssHeight;
  renderer.resize(data.width, data.height);

  // No explicit reapply — GraticuleLayer.update reads frame.dpr each tick.
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

  // Aurora layer registry dispatch (Phase 1: registry empty, no-op).
  // Built-in layers absorb into AuroraLayer instances from Phase 2 onward and the
  // if/else branches above shrink as each layer migrates.
  renderer!.getLayerRegistry().onDataChanged(layerId, [], renderer!.getLayerContext());

  // Combined buffer/texture for fragment shader param bindings
  updateCombinedParam(param, slot0, slot1);
}

function handleDeactivateSlots(data: Extract<AuroraRequest, { type: 'deactivateSlots' }>): void {
  const state = paramSlotStates.get(data.param);
  if (state) {
    state.dataReady = false;
  }
}

async function handleRegisterUserLayer(data: Extract<AuroraRequest, { type: 'registerUserLayer' }>): Promise<void> {
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

  try {
    const layers = layerRegistry.getAll();
    const composedShaders = await shaderComposer.compose(layers);
    await queuePipelineRecreation(composedShaders);
    rebuildParamBindings();
    writeParamSizes();
    rebindAllParamBuffers();
    console.log(`[Aurora] Pipeline recreated with ${layers.length} layers`);
    self.postMessage({ type: 'userLayerResult', layerId: layer.id, success: true });
  } catch (err) {
    layerRegistry!.unregister(layer.id);
    if (layer.userLayerIndex !== undefined) {
      userLayerOpacities.delete(layer.userLayerIndex);
      userLayerEnabled.delete(layer.userLayerIndex);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Aurora] Shader compilation failed:', message);
    self.postMessage({ type: 'userLayerResult', layerId: layer.id, success: false, error: message });
  }
}

async function handleUnregisterUserLayer(data: Extract<AuroraRequest, { type: 'unregisterUserLayer' }>): Promise<void> {
  const layerId = data.layerId as TLayer ;  // QC-OK: message boundary, validated by sender
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

  try {
    const layers = layerRegistry.getAll();
    const composedShaders = await shaderComposer.compose(layers);
    await queuePipelineRecreation(composedShaders);
    rebuildParamBindings();
    writeParamSizes();
    rebindAllParamBuffers();
    console.log('[Aurora] Pipeline recreated with', layers.length, 'layers');
  } catch (err) {
    console.error('[Aurora] Pipeline recreation failed:', err);
  }
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
  if (data.paletteRange && renderer) {
    renderer.setUserLayerPaletteRange(data.layerIndex, data.paletteRange[0], data.paletteRange[1]);
  }
}

// Deferred capture: set flag, actual capture happens after next render
const { handleCaptureFrame, flushCaptureFrame } = createCaptureHandler(() => renderer);

async function handleRecordBatch(data: Extract<AuroraRequest, { type: 'recordBatch' }>): Promise<void> {
  if (!canvas || !renderer) return;
  const { camera, time, fixedDtMs, totalFrames } = data;
  const dt = fixedDtMs / 1000;
  const bitmaps: ImageBitmap[] = [];

  for (let i = 0; i < totalFrames; i++) {
    updateAnimatedOpacities(dt, time);
    const uniforms = buildUniforms(camera, new Date(time));
    renderer.setFrameDelta(fixedDtMs);
    renderer.updateUniforms(uniforms);

    // Build animated user layer opacities
    const animatedUserOpacities = new Map<number, number>();
    for (const layer of layerRegistry!.getAll()) {
      if (!layer.isBuiltIn && layer.userLayerIndex !== undefined) {
        animatedUserOpacities.set(layer.userLayerIndex, animatedOpacity.get(layer.id)!);
      }
    }
    renderer.setUserLayerOpacities(animatedUserOpacities);

    // Update dynamic param state
    for (const [param, binding] of paramBindings) {
      const state = paramSlotStates.get(param);
      if (state) {
        const lerp = state.dataReady ? computeLerp(state, time) : -1;
        renderer.setParamState(binding.index, lerp, state.dataReady);
        const dtSeconds = (state.t1 - state.t0) / 1000;
        renderer.setParamDt(binding.index, dtSeconds);
      }
    }

    // DO NOT CHANGE THIS ORDER — see handleRender for explanation.
    renderer.uploadUniforms();
    renderer.render();
    const bitmap = await renderer.readbackFrame();
    bitmaps.push(bitmap);
    (self as unknown as Worker).postMessage({ type: 'recordProgress', frameIndex: i + 1 } satisfies AuroraResponse);
  }

  const msg: AuroraResponse = { type: 'recordBatchComplete', bitmaps };
  (self as unknown as Worker).postMessage(msg, bitmaps);
}

// ============================================================
// Sub-B Phase 5 typed setters — per-layer migration drops these stubs and
// wires the typed mutator path. Each call here means a UI bind-point sent the
// new typed message before its layer migrated; throw loudly so we notice.
// ============================================================

function handleSetEngineOptions(data: Extract<AuroraRequest, { type: 'setEngineOptions' }>): void {
  options.updateEngine(data.patch);
  postOptionsChanged();
}

function handleSetLayerOpacity(data: Extract<AuroraRequest, { type: 'setLayerOpacity' }>): void {
  options.updateLayer(data.id, { opacity: data.value });
  postOptionsChanged();
}

function handleSetLayerEnabled(data: Extract<AuroraRequest, { type: 'setLayerEnabled' }>): void {
  layerEnabled.set(data.id, data.value);
}

const KNOWN_LAYER_IDS = new Set(['graticule', 'cities', 'temp', 'wind', 'pressure', 'rain']);

function handleSetLayerOptions(data: Extract<AuroraRequest, { type: 'setLayerOptions' }>): void {
  if (!KNOWN_LAYER_IDS.has(data.id)) {
    throw new Error(`setLayerOptions('${data.id}') handler not yet wired (layer not migrated)`);
  }
  const prev = options.read().layers[data.id];
  options.updateLayer(data.id, { opts: data.opts as Record<string, unknown> });
  const next = options.read().layers[data.id]!;
  applyLayerSideEffects(data.id, prev, next);
  postOptionsChanged();
}

async function handleNukeOptions(): Promise<void> {
  // Sync in-memory reset is part of clear() — completes before the await,
  // so any post-nuke setLayerOpacity / setLayerOptions arriving next in the
  // FIFO sees fresh defaults. The await drains the durable IDB delete.
  await options.clear();
  postOptionsChanged();
}

async function handleCleanup(): Promise<void> {
  // Drain any pending debounced save before tearing down so the last drag
  // value lands durably.
  await options.flush();

  for (const buffer of paramCombinedBuffers.values()) {
    buffer.destroy();
  }
  paramCombinedBuffers.clear();
  for (const texture of paramCombinedTextures.values()) {
    texture.destroy();
  }
  paramCombinedTextures.clear();

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
  setEngineOptions: handleSetEngineOptions,
  setLayerOpacity: handleSetLayerOpacity,
  setLayerEnabled: handleSetLayerEnabled,
  setLayerOptions: handleSetLayerOptions,
  nukeOptions: handleNukeOptions,
  render: handleRender,
  resize: handleResize,
  uploadData: handleUploadData,
  activateSlots: handleActivateSlots,
  deactivateSlots: handleDeactivateSlots,
  registerUserLayer: handleRegisterUserLayer,
  unregisterUserLayer: handleUnregisterUserLayer,
  setUserLayerOptions: handleSetUserLayerOptions,
  captureFrame: handleCaptureFrame,
  recordBatch: handleRecordBatch,
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
