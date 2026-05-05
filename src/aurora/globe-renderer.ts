/**
 * GlobeRenderer - WebGPU globe rendering
 */

import { Camera, type CameraConfig } from './camera';
import { type ComposedShaders, activeParamBindings, type ParamBindingConfig } from './shader-composer';
import { createAtmosphereLUTs, type AtmosphereLUTs, type AtmosphereLUTData } from './atmosphere-luts';
import { PressureAuroraLayer, type PressureAuroraLayerHost } from './built_ins/pressure/pressure-aurora-layer';
import { WindAuroraLayer, type WindAuroraLayerHost } from './built_ins/wind/wind-aurora-layer';
import { GRATICULE_BUFFER_SIZE } from './built_ins/graticule/graticule-animator';
import { GraticuleLayer, type GraticuleLodLevel } from './built_ins/graticule/graticule-layer';
import { LOOKUP_WIDTH, LOOKUP_HEIGHT } from './built_ins/cities/cities-layer';
import { CitiesAuroraLayer, type CitiesLodLevel, type CitiesAuroraLayerHost } from './built_ins/cities/cities-aurora-layer';
import { U, UNIFORM_BUFFER_SIZE, getUserLayerOpacityOffset, getUserLayerPaletteIndexOffset, getUserLayerPaletteRangeOffset, getLayerOpacityOffset, getLayerDataReadyOffset, getLayerPaletteIndexOffset, getLayerPaletteRangeOffset, getParamLerpOffset, getParamReadyOffset, getParamDtOffset, getParamSizeOffset } from './globe-uniforms';
import { GpuTimestamp, type PassTimings } from './gpu-timestamp';
import { PaletteTexture } from './palette-texture';
import { createCaptureTexture, readbackFrame as readbackFrameImpl } from './capture';
import { AuroraLayerRegistry } from './aurora-layer-registry';
import type { AuroraDataEvent, AuroraLayerContext, AuroraLayerFrame } from './types/aurora-layer';

// Re-export for consumers
export type { PassTimings } from './gpu-timestamp';
import type { LayerState } from '../config/types';
import { PRESSURE_COLOR_DEFAULT, type PressureColorOption } from '../schemas/options.schema';
import { PALETTE_IDS, PALETTES, type PaletteId } from '../services/palette-service';

// Layer indices for uniform array access (must match registration order in BUILT_IN_LAYERS)
export const LAYER_EARTH = 0;
export const LAYER_SUN = 1;
export const LAYER_GRATICULE = 2;
export const LAYER_CITIES = 3;
export const LAYER_TEMP = 4;
export const LAYER_RAIN = 5;
export const LAYER_CLOUDS = 6;
export const LAYER_PRESSURE = 7;
export const LAYER_WIND = 8;

export interface GlobeUniforms {
  viewProj: Float32Array;
  viewProjInverse: Float32Array;
  eyePosition: Float32Array;
  resolution: Float32Array;
  time: number;
  tanFov: number;
  sunDirection: Float32Array;
  // Per-layer state indexed by LAYER_* constants
  layerOpacities: Float32Array;   // indexed by LAYER_EARTH, LAYER_SUN, etc.
  layerDataReady: boolean[];      // indexed by LAYER_TEMP, LAYER_RAIN, etc.
  // Wind/pressure have separate render passes with special state
  windLerp: number;
  windAnimSpeed: number;  // updates per second
  windState: LayerState;  // full state for compute caching
  pressureColors: PressureColorOption;
  logoOpacity: number;       // computed from all layer opacities
  rainBackFace: number;
  rainAnimated: boolean;
}

const POINTS_PER_TIMESTEP = 6_599_680;
const BYTES_PER_TIMESTEP = POINTS_PER_TIMESTEP * 4;  // ~26.4 MB per slot

export class GlobeRenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private pipeline!: GPURenderPipeline;
  private uniformBuffer!: GPUBuffer;
  private bindGroup!: GPUBindGroup;
  private bindGroupLayout!: GPUBindGroupLayout;
  private basemapTexture!: GPUTexture;
  private basemapSampler!: GPUSampler;
  private gaussianGridBuffer!: GPUBuffer;  // packed lats + offsets as vec2<u32>
  // Weather data buffers use dynamic param bindings
  private placeholderBuffer!: GPUBuffer;  // 4-byte placeholder for unbound params
  private atmosphereLUTs!: AtmosphereLUTs;
  private useFloat16Luts = false;
  private format!: GPUTextureFormat;
  private fontAtlasTexture!: GPUTexture;
  private fontAtlasSampler!: GPUSampler;
  private paletteTexture!: PaletteTexture;
  private logoTexture!: GPUTexture;
  private logoSampler!: GPUSampler;
  private depthTexture!: GPUTexture;
  // Post-process pass for atmosphere
  private colorTexture!: GPUTexture;
  // Owned capture texture — post-process renders here, readback reads from here
  // (never auto-presented, so content is stable for GPU readback on all platforms)
  private captureTexture!: GPUTexture;
  // Pressure contour layer (registered with AuroraLayerRegistry; held to forward the
  // worker's heavy compute orchestration through getInner() — see Phase 5 escape hatch).
  private pressureAuroraLayer!: PressureAuroraLayer;
  private currentPressureColors: PressureColorOption = PRESSURE_COLOR_DEFAULT;
  // Wind layer (registered with AuroraLayerRegistry; per-frame host-handle state below)
  private windLayerState: LayerState = { mode: 'loading', lerp: 0, time: new Date(0) };
  private windAnimSpeed = 0;
  // Dynamic param buffers (keyed by param name) — combined t0+t1 buffers
  private paramBuffers = new Map<string, GPUBuffer>();
  // Dynamic param textures (keyed by param name) — combined t0+t1 textures for texture-backed params
  private paramTextures = new Map<string, GPUTexture>();
  private placeholderParamTexture!: GPUTexture;
  // Current param binding config (set by recreatePipeline)
  private currentParamBindings: ParamBindingConfig[] = [];
  // Graticule animation (lines buffer is bound at @binding(21); the layer plugin writes it)
  private graticuleLinesBuffer!: GPUBuffer;
  // Cities layer
  private cityLookupTexture!: GPUTexture;
  private cityDataBuffer!: GPUBuffer;  // combined cities + glyphs
  private cityFontAtlasTexture!: GPUTexture;
  private cityFontSampler!: GPUSampler;
  private postProcessPipeline!: GPURenderPipeline;
  private postProcessBindGroup!: GPUBindGroup;
  private postProcessBindGroupLayout!: GPUBindGroupLayout;
  private colorSampler!: GPUSampler;

  readonly camera: Camera;
  private uniformData = new ArrayBuffer(UNIFORM_BUFFER_SIZE);
  private uniformView = new DataView(this.uniformData);

  // Track layer opacities for depth test decision
  private currentLayerOpacities = new Float32Array(16);

  // Animation timing (shared across grid, wind, etc.)
  private lastFrameTime = 0;
  private frameDeltaMs = 0;    // milliseconds since last frame (0 on first frame)
  private frameDeltaFixed = false;  // true when setFrameDelta was called for this frame
  private rainAnimTime = 0;   // accumulated rain animation time (seconds)

  // GPU timing
  private gpuTimestamp: GpuTimestamp | null = null;

  // Suppress errors during intentional page unload
  private isDestroying = false;

  // Aurora layer registry — Phase 1 of aurora-autarky Sub-A. Empty until Phase 2+.
  private layerRegistry = new AuroraLayerRegistry();
  // Per-frame state references captured in updateUniforms() for layer dispatch in render()
  private currentViewProj!: Float32Array;
  private currentEyePosition!: Float32Array;
  private currentSunDirection!: Float32Array;
  private currentGlobeRadiusPx = 0;

  // Device pixel ratio from main thread — workers can't reliably read devicePixelRatio
  // (Chrome workers may lack it, Safari may differ). Used to convert device-pixel
  // canvas dimensions to CSS pixels for graticule LoD thresholds.
  dpr: number;
  cssHeight: number;

  constructor(private canvas: HTMLCanvasElement | OffscreenCanvas, cameraConfig?: CameraConfig, dpr = 1, cssHeight = 0) {
    this.camera = new Camera({ lat: 30, lon: 0, distance: 3 }, cameraConfig);
    this.dpr = dpr;
    this.cssHeight = cssHeight || (canvas as HTMLCanvasElement).clientHeight || canvas.height / dpr;
  }

  async initialize(
    requestedSlots: number,
    windLineCount: number,
    composedShaders: ComposedShaders,
    graticuleLodLevels: GraticuleLodLevel[],
    windConfig: { snakeLength: number; lineWidth: number; segmentsPerLine: number; stepFactor: number; radius: number }
  ): Promise<void> {
    const shaderCode = composedShaders.main;
    const postprocessShaderCode = composedShaders.post;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter found');

    // Request higher limits based on requested slots
    const adapterStorageLimit = adapter.limits.maxStorageBufferBindingSize;
    const adapterBufferLimit = adapter.limits.maxBufferSize;
    const cap = requestedSlots * BYTES_PER_TIMESTEP;

    // Check for float32-filterable support (use float16 LUTs if not available)
    const hasFloat32Filterable = adapter.features.has('float32-filterable');
    this.useFloat16Luts = !hasFloat32Filterable;

    // Check for timestamp-query support
    const hasTimestampQuery = GpuTimestamp.isSupported(adapter);

    const requiredFeatures: GPUFeatureName[] = [];
    if (hasFloat32Filterable) requiredFeatures.push('float32-filterable');
    if (hasTimestampQuery) requiredFeatures.push('timestamp-query');

    // Request higher storage buffer limit for dynamic param bindings
    const adapterStorageBuffersLimit = adapter.limits.maxStorageBuffersPerShaderStage;
    const requiredStorageBuffers = Math.min(adapterStorageBuffersLimit, 32);  // 8 legacy + up to 24 dynamic params

    this.device = await adapter.requestDevice({
      requiredFeatures,
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(adapterStorageLimit, cap),
        maxBufferSize: Math.min(adapterBufferLimit, cap),
        maxStorageBuffersPerShaderStage: requiredStorageBuffers,
      },
    });

    // Handle device loss (suppress during intentional destroy)
    this.device.lost.then((info) => {
      if (info.reason !== 'destroyed') {
        console.error('[Globe] WebGPU device lost:', info.message, info.reason);
      }
    });

    // WORKAROUND for Chrome bug 469455157: GPU crash on reload
    // Explicitly destroy device before page unload to prevent SharedImage mailbox race
    // Skip in worker context (cleanup handled via message from main thread)
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.isDestroying = true;
        this.canvas.getContext('webgpu')!.unconfigure();
        this.device.destroy();
      });
    }

    // Wait for device to be fully ready
    await this.device.queue.onSubmittedWorkDone();

    this.context = this.canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });

    // Create GPU timestamp helper if supported
    if (hasTimestampQuery) {
      this.gpuTimestamp = new GpuTimestamp(this.device);
    }

    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_BUFFER_SIZE,  // Calculated from GLOBE_UNIFORMS layout
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Placeholder basemap (1x1 cube texture)
    this.basemapTexture = this.device.createTexture({
      size: [1, 1, 6],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.basemapSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    // Gaussian grid LUTs (packed lats + offsets as vec2<u32>)
    const numRings = 2560;
    this.gaussianGridBuffer = this.device.createBuffer({
      size: numRings * 8,  // 2 × u32 per ring
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Placeholder buffer for unbound dynamic params (storage)
    this.placeholderBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Placeholder texture for unbound dynamic params (texture)
    this.placeholderParamTexture = this.device.createTexture({
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Graticule lines buffer for animated LoD
    this.graticuleLinesBuffer = this.device.createBuffer({
      size: GRATICULE_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Cities lookup texture (R16Uint, 2048×1024)
    this.cityLookupTexture = this.device.createTexture({
      size: [LOOKUP_WIDTH, LOOKUP_HEIGHT],
      format: 'r16uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Cities storage buffer (placeholder, will be resized on first LOD build)
    this.cityDataBuffer = this.device.createBuffer({
      size: 32,  // minimum, resized on LOD build
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Placeholder cities font atlas (1x1, replaced by loadCitiesFontAtlas)
    this.cityFontAtlasTexture = this.device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.cityFontSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Placeholder font atlas (1x1, will be replaced by loadFontAtlas)
    this.fontAtlasTexture = this.device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.fontAtlasSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Shared palette texture array (256×N, one row per palette)
    this.paletteTexture = new PaletteTexture(this.device);

    // Register built-in graticule layer (initialize at correct LoD for globe screen size)
    {
      const distance = this.camera.getState().distance;
      const fov = 2 * Math.atan(this.camera.getTanFov());
      const heightCss = this.canvas.height / this.dpr;
      const initialGlobeRadiusPx = Math.asin(1 / distance) * (heightCss / fov);
      this.layerRegistry.register(
        new GraticuleLayer(initialGlobeRadiusPx, graticuleLodLevels, this.graticuleLinesBuffer),
        this.getLayerContext(),
      );
    }

    // Initialize palette uniforms
    this.uniformView.setUint32(U.paletteCount, this.paletteTexture.paletteCount, true);

    // Compute paletteStepped bitmask — bit i = 1 means palette i is stepped
    let steppedBitmask = 0;
    for (let i = 0; i < PALETTE_IDS.length && i < 32; i++) {
      if (!PALETTES[PALETTE_IDS[i]!]!.interpolate) {
        steppedBitmask |= (1 << i);
      }
    }
    this.uniformView.setUint32(U.paletteStepped, steppedBitmask, true);

    // Placeholder logo (1x1, will be replaced by loadLogo)
    this.logoTexture = this.device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.logoSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Offscreen textures for two-pass rendering (globe + post-process)
    // Use canvas.width/height directly (already device pixels in worker)
    const texWidth = this.canvas.width || 800;
    const texHeight = this.canvas.height || 600;

    // Color texture (globe renders here, post-process reads)
    this.colorTexture = this.device.createTexture({
      size: [texWidth, texHeight],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    // Capture texture (post-process renders here, readback reads from here)
    this.captureTexture = createCaptureTexture(this.device, texWidth, texHeight, this.format);

    // Depth texture (globe writes, post-process reads for world position reconstruction)
    this.depthTexture = this.device.createTexture({
      size: [texWidth, texHeight],
      format: 'depth32float',  // Need float for texture binding
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    // Sampler for reading color/depth textures in post-process
    this.colorSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Shader code is pre-processed by wgsl-plus (see vite.config.ts)
    const shaderModule = this.device.createShaderModule({ code: shaderCode });
    const postProcessModule = this.device.createShaderModule({ code: postprocessShaderCode });

    // Store current param bindings for dynamic layout (set by ShaderComposer.compose())
    this.currentParamBindings = [...activeParamBindings];

    // Create bind group layout with dynamic param entries
    this.bindGroupLayout = this.createDynamicBindGroupLayout();

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });

    // Post-process bind group layout (atmosphere applied after globe render)
    this.postProcessBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // sceneColor
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },  // sceneDepth
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        // Atmosphere LUTs
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // transmittance
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },  // scattering
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    this.postProcessPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.postProcessBindGroupLayout] }),
      vertex: { module: postProcessModule, entryPoint: 'vs_main' },
      fragment: { module: postProcessModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });

    // Register pressure AuroraLayer (built-in). Per-frame opacity/colors and the
    // cross-layer backface-cull hint flow through the host handle.
    {
      const renderer = this;
      const pressureHost: PressureAuroraLayerHost = {
        getOpacity() { return renderer.currentLayerOpacities[LAYER_PRESSURE]!; },
        getColors() { return renderer.currentPressureColors; },
        getBackfaceCull() {
          return renderer.currentLayerOpacities[LAYER_EARTH]! > 0.01
            || renderer.currentLayerOpacities[LAYER_TEMP]! > 0.01
            || renderer.currentLayerOpacities[LAYER_SUN]! > 0.01;
        },
      };
      this.pressureAuroraLayer = new PressureAuroraLayer(pressureHost);
      this.layerRegistry.register(this.pressureAuroraLayer, this.getLayerContext());
    }

    // Register wind AuroraLayer (built-in). Per-frame opacity / layer-state /
    // animSpeed flow through the host handle; updateUniforms() captures them.
    {
      const renderer = this;
      const windHost: WindAuroraLayerHost = {
        getOpacity() { return renderer.currentLayerOpacities[LAYER_WIND]!; },
        getLayerState() { return renderer.windLayerState; },
        getAnimSpeed() { return renderer.windAnimSpeed; },
        getShowBackface() {
          const maxOpacity = Math.max(
            renderer.currentLayerOpacities[LAYER_EARTH]!,
            renderer.currentLayerOpacities[LAYER_TEMP]!,
          );
          const t = Math.max(0, Math.min(1, (0.3 - maxOpacity) / 0.3));
          return t * t * (3 - 2 * t);
        },
      };
      this.layerRegistry.register(
        new WindAuroraLayer(windLineCount, windConfig, windHost),
        this.getLayerContext(),
      );
    }

    this.resize();
  }

  /**
   * Create atmosphere LUT textures from pre-loaded data
   * Called by DataLoader after fetching LUT files
   */
  createAtmosphereTextures(data: AtmosphereLUTData): void {
    this.atmosphereLUTs = createAtmosphereLUTs(this.device, data, this.useFloat16Luts);
  }

  /**
   * Finalize renderer setup - creates bind groups after all textures are loaded
   * Must be called after createAtmosphereTextures() and loadBasemap()
   */
  finalize(): void {
    // Globe pass bind group (includes dynamic param entries)
    this.recreateBindGroup();

    // Post-process bind group for atmosphere pass
    this.createPostProcessBindGroup();
  }

  /**
   * Get whether float16 LUTs should be used (determined during initialize)
   */
  getUseFloat16Luts(): boolean {
    return this.useFloat16Luts;
  }

  /**
   * Set user layer opacity uniforms
   * Called each frame with current opacity values
   */
  setUserLayerOpacities(opacities: Map<number, number>): void {
    for (const [index, opacity] of opacities) {
      const offset = getUserLayerOpacityOffset(index);
      this.uniformView.setFloat32(offset, opacity, true);
    }
  }

  /**
   * Set user layer palette index uniform
   */
  setUserLayerPaletteIndex(layerIndex: number, paletteIndex: number): void {
    const offset = getUserLayerPaletteIndexOffset(layerIndex);
    this.uniformView.setUint32(offset, paletteIndex, true);
  }

  /**
   * Set palette data range for a user layer by user layer index
   */
  setUserLayerPaletteRange(layerIndex: number, min: number, max: number): void {
    const offset = getUserLayerPaletteRangeOffset(layerIndex);
    this.uniformView.setFloat32(offset, min, true);
    this.uniformView.setFloat32(offset + 4, max, true);
  }

  /**
   * Recreate render pipeline with new shader code
   * Used when user layers are added/removed
   */
  async recreatePipeline(composedShaders: ComposedShaders): Promise<void> {
    // Create new shader modules
    const shaderModule = this.device.createShaderModule({ code: composedShaders.main });
    const postProcessModule = this.device.createShaderModule({ code: composedShaders.post });

    // Check for shader compilation errors
    const [mainInfo, postInfo] = await Promise.all([
      shaderModule.getCompilationInfo(),
      postProcessModule.getCompilationInfo(),
    ]);

    const errors = [...mainInfo.messages, ...postInfo.messages].filter(m => m.type === 'error');
    if (errors.length > 0) {
      const errorMsg = errors.map(e => `Line ${e.lineNum}: ${e.message}`).join('\n');
      throw new Error(errorMsg);
    }

    // Store current param bindings from ShaderComposer
    this.currentParamBindings = [...activeParamBindings];

    // Recreate bind group layout with dynamic param entries
    this.bindGroupLayout = this.createDynamicBindGroupLayout();

    // Use error scopes to catch silent WebGPU validation errors
    this.device.pushErrorScope('validation');

    // Recreate main pipeline with new layout
    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });

    const mainError = await this.device.popErrorScope();
    if (mainError) {
      console.error('[GlobeRenderer] Main pipeline validation error:', mainError.message);
      throw new Error(`Pipeline validation: ${mainError.message}`);
    }

    this.device.pushErrorScope('validation');

    // Recreate post-process pipeline
    this.postProcessPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.postProcessBindGroupLayout] }),
      vertex: { module: postProcessModule, entryPoint: 'vs_main' },
      fragment: { module: postProcessModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });

    const postError = await this.device.popErrorScope();
    if (postError) {
      console.error('[GlobeRenderer] Post pipeline validation error:', postError.message);
      throw new Error(`Post pipeline validation: ${postError.message}`);
    }

    // Recreate bind group with new layout
    this.device.pushErrorScope('validation');
    this.recreateBindGroup();
    const bindGroupError = await this.device.popErrorScope();
    if (bindGroupError) {
      console.error('[GlobeRenderer] Bind group validation error:', bindGroupError.message);
      throw new Error(`Bind group validation: ${bindGroupError.message}`);
    }
  }

  /**
   * Resize canvas and recreate textures
   * @param explicitWidth Device pixel width (for OffscreenCanvas in worker)
   * @param explicitHeight Device pixel height (for OffscreenCanvas in worker)
   */
  resize(explicitWidth?: number, explicitHeight?: number): void {
    let width: number;
    let height: number;

    if (explicitWidth !== undefined && explicitHeight !== undefined) {
      // Worker mode: dimensions passed explicitly
      width = explicitWidth;
      height = explicitHeight;
    } else if ('clientWidth' in this.canvas) {
      // Main thread mode: compute from CSS size
      const dpr = window.devicePixelRatio;
      width = Math.floor(this.canvas.clientWidth * dpr);
      height = Math.floor(this.canvas.clientHeight * dpr);
    } else {
      // Fallback: use current canvas size
      width = this.canvas.width;
      height = this.canvas.height;
    }

    this.canvas.width = width;
    this.canvas.height = height;
    this.camera.setAspect(width, height);

    // Recreate offscreen textures at new size
    this.colorTexture?.destroy();
    this.colorTexture = this.device.createTexture({
      size: [width, height],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.captureTexture?.destroy();
    this.captureTexture = createCaptureTexture(this.device, width, height, this.format);

    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    // Recreate post-process bind group with new texture views (if LUTs loaded)
    if (this.atmosphereLUTs) {
      this.createPostProcessBindGroup();
    }
  }

  private createPostProcessBindGroup(): void {
    this.postProcessBindGroup = this.device.createBindGroup({
      layout: this.postProcessBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.colorTexture.createView() },
        { binding: 2, resource: this.depthTexture.createView() },
        { binding: 3, resource: this.colorSampler },
        { binding: 4, resource: this.atmosphereLUTs.transmittance.createView() },
        { binding: 5, resource: this.atmosphereLUTs.scattering.createView() },
        { binding: 6, resource: this.atmosphereLUTs.sampler },
      ],
    });
  }

  /** Override frame delta for deterministic recording */
  setFrameDelta(ms: number): void {
    this.frameDeltaMs = ms;
    this.frameDeltaFixed = true;
  }

  updateUniforms(uniforms: GlobeUniforms): void {
    // Compute frame delta time for animations (skip if setFrameDelta was called)
    const now = performance.now();
    if (this.frameDeltaFixed) {
      this.frameDeltaFixed = false;
    } else if (this.lastFrameTime > 0) {
      this.frameDeltaMs = Math.min(now - this.lastFrameTime, 100);  // Cap at 100ms
    }
    this.lastFrameTime = now;

    // Cache frame-state references for plugin dispatch in render()
    this.currentViewProj = uniforms.viewProj;
    this.currentEyePosition = uniforms.eyePosition;
    this.currentSunDirection = uniforms.sunDirection;

    const view = this.uniformView;
    const O = U; // Offsets from layout

    // mat4 viewProjInverse
    for (let i = 0; i < 16; i++) {
      view.setFloat32(O.viewProjInverse + i * 4, uniforms.viewProjInverse[i]!, true);
    }

    // vec3 eyePosition
    view.setFloat32(O.eyePosition, uniforms.eyePosition[0]!, true);
    view.setFloat32(O.eyePosition + 4, uniforms.eyePosition[1]!, true);
    view.setFloat32(O.eyePosition + 8, uniforms.eyePosition[2]!, true);

    // vec2 resolution + tanFov
    view.setFloat32(O.resolution, uniforms.resolution[0]!, true);
    view.setFloat32(O.resolution + 4, uniforms.resolution[1]!, true);
    view.setFloat32(O.tanFov, uniforms.tanFov, true);

    // time
    view.setFloat32(O.time, uniforms.time, true);

    // vec3 sunDirection
    view.setFloat32(O.sunDirection, uniforms.sunDirection[0]!, true);
    view.setFloat32(O.sunDirection + 4, uniforms.sunDirection[1]!, true);
    view.setFloat32(O.sunDirection + 8, uniforms.sunDirection[2]!, true);

    // Built-in layer opacities and data ready flags (indexed arrays)
    for (let i = 0; i < uniforms.layerOpacities.length; i++) {
      view.setFloat32(getLayerOpacityOffset(i), uniforms.layerOpacities[i]!, true);
    }
    for (let i = 0; i < uniforms.layerDataReady.length; i++) {
      view.setUint32(getLayerDataReadyOffset(i), uniforms.layerDataReady[i] ? 1 : 0, true);
    }

    // Track for depth test decision in render()
    this.currentLayerOpacities.set(uniforms.layerOpacities);

    // Logo
    view.setFloat32(O.logoOpacity, uniforms.logoOpacity, true);

    // Rain (dynamic: backface depends on which layers are enabled)
    view.setFloat32(O.rainBackFace, uniforms.rainBackFace, true);
    if (uniforms.rainAnimated) this.rainAnimTime += this.frameDeltaMs / 1000;
    view.setFloat32(O.rainAnimTime, this.rainAnimTime, true);

    // Note: uniform buffer upload deferred to uploadUniforms() so callers
    // can write param state (lerp, ready, dt) before the GPU copy.

    // Update graticule animation based on globe screen size
    const cameraDistance = Math.sqrt(
      uniforms.eyePosition[0]! ** 2 +
      uniforms.eyePosition[1]! ** 2 +
      uniforms.eyePosition[2]! ** 2
    );
    const fov = 2 * Math.atan(uniforms.tanFov);
    const globeRadiusPx = Math.asin(1 / cameraDistance) * (this.cssHeight / fov);
    this.currentGlobeRadiusPx = globeRadiusPx;
    // Graticule lines buffer is now written by GraticuleLayer.update() via the registry's
    // updateAll dispatch in render() — no direct call here.

    // Cities: font scaling based on altitude (viewport-independent)
    // Alt <= 3000: 1.3× world-space multiplier, alt > 3000: indicators only
    const altitudeKm = (cameraDistance - 1) * 6371;
    const cityFontScale = altitudeKm > 3000 ? 0 : 1.3;
    view.setFloat32(O.cityFontScale, cityFontScale, true);
    view.setFloat32(O.globeRadiusPx, globeRadiusPx, true);

    // Cities LoD update is handled by CitiesAuroraLayer via the registry's
    // updateAll dispatch in render() — no direct call here.

    // Pressure: setEnabled/updateUniforms run inside PressureAuroraLayer.update()
    // via the registry's updateAll dispatch. Capture per-frame inputs the host
    // handle exposes back to the layer.
    this.currentPressureColors = uniforms.pressureColors;

    // Wind layer: advance/setState/uniforms now run inside WindAuroraLayer.update()
    // via the registry's updateAll dispatch. Capture per-frame inputs that the
    // wind host handle exposes back to the layer.
    this.windLayerState = uniforms.windState;
    this.windAnimSpeed = uniforms.windAnimSpeed;
  }

  /** Upload uniform buffer to GPU. Call after all setParamState/setParamDt writes. */
  uploadUniforms(): void {
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
  }

  render(): PassTimings {
    if (this.isDestroying) return { pass1Ms: NaN, pass2Ms: NaN, pass3Ms: NaN };
    const commandEncoder = this.device.createCommandEncoder();

    // Aurora layer frame (Phase 1: registry empty so all dispatch is no-op).
    // opacity/dataReady are placeholders; per-layer resolution lands when real
    // layers register in Phase 2+.
    const layerFrame: AuroraLayerFrame = {
      commandEncoder,
      viewProj: this.currentViewProj,
      eyePosition: this.currentEyePosition,
      sunDirection: this.currentSunDirection,
      opacity: 0,
      dataReady: false,
      frameDeltaMs: this.frameDeltaMs,
      globeRadiusPx: this.currentGlobeRadiusPx,
      time: new Date(),
    };
    this.layerRegistry.updateAll(layerFrame);

    // PASS 1: Render globe to offscreen textures (no atmosphere)
    // Use timestampWrites for GPU timing (spec-compliant approach)
    const globePassDescriptor: GPURenderPassDescriptor = {
      colorAttachments: [{
        view: this.colorTexture.createView(),
        clearValue: { r: 0.086, g: 0.086, b: 0.086, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    };

    // Add timestampWrites if supported
    if (this.gpuTimestamp) {
      globePassDescriptor.timestampWrites = this.gpuTimestamp.getPass1TimestampWrites();
    }

    const globePass = commandEncoder.beginRenderPass(globePassDescriptor);

    globePass.setPipeline(this.pipeline);
    globePass.setBindGroup(0, this.bindGroup);
    globePass.draw(3);
    globePass.end();

    // COMPUTE PASS: Wind line tracing dispatches via the registry (Phase 4).
    this.layerRegistry.computeAll(layerFrame);

    // PASS 2: Geometry layers (pressure contours, wind, etc.)
    // Renders to same color/depth textures, depth-tested against globe
    // Always run pass for timestamp consistency (even if empty)
    const useGlobeDepth = this.currentLayerOpacities[LAYER_EARTH]! > 0.01 || this.currentLayerOpacities[LAYER_TEMP]! > 0.01 || this.currentLayerOpacities[LAYER_SUN]! > 0.01;

    const geometryPassDescriptor: GPURenderPassDescriptor = {
      colorAttachments: [{
        view: this.colorTexture.createView(),
        loadOp: 'load',  // Preserve globe render
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: useGlobeDepth ? 'load' : 'clear',
        depthStoreOp: 'store',
      },
    };

    if (this.gpuTimestamp) {
      geometryPassDescriptor.timestampWrites = this.gpuTimestamp.getPass2TimestampWrites();
    }

    const geometryPass = commandEncoder.beginRenderPass(geometryPassDescriptor);

    // Pressure + wind render inside the geometry pass via the registry's renderAll dispatch.
    this.layerRegistry.renderAll(layerFrame, geometryPass);

    geometryPass.end();

    // PASS 3: Post-process - render to owned captureTexture (stable for readback)
    const captureView = this.captureTexture.createView();
    const postProcessDescriptor: GPURenderPassDescriptor = {
      colorAttachments: [{
        view: captureView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    };

    if (this.gpuTimestamp) {
      postProcessDescriptor.timestampWrites = this.gpuTimestamp.getPass3TimestampWrites();
    }

    const postProcessPass = commandEncoder.beginRenderPass(postProcessDescriptor);

    postProcessPass.setPipeline(this.postProcessPipeline);
    postProcessPass.setBindGroup(0, this.postProcessBindGroup);
    postProcessPass.draw(3);
    postProcessPass.end();

    // Copy capture texture to canvas for display
    const canvasTexture = this.context.getCurrentTexture();
    commandEncoder.copyTextureToTexture(
      { texture: this.captureTexture },
      { texture: canvasTexture },
      { width: canvasTexture.width, height: canvasTexture.height }
    );

    // Encode timestamp resolve commands BEFORE submit
    if (this.gpuTimestamp) {
      this.gpuTimestamp.encodeResolve(commandEncoder);
    }

    this.device.queue.submit([commandEncoder.finish()]);

    // Start async readback AFTER submit (critical ordering)
    if (this.gpuTimestamp) {
      this.gpuTimestamp.startReadback();
    }

    return this.gpuTimestamp?.getLastTimings() ?? { pass1Ms: NaN, pass2Ms: NaN, pass3Ms: NaN };  // QC-OK: timing optional
  }

  async loadBasemap(faces: ImageBitmap[]): Promise<void> {
    if (faces.length !== 6) throw new Error('Expected 6 cube map faces');
    const size = faces[0]!.width;

    this.basemapTexture.destroy();
    this.basemapTexture = this.device.createTexture({
      size: [size, size, 6],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    for (let i = 0; i < 6; i++) {
      this.device.queue.copyExternalImageToTexture(
        { source: faces[i]! },
        { texture: this.basemapTexture, origin: [0, 0, i] },
        [size, size]
      );
    }

    this.recreateBindGroup();
  }

  /**
   * Load MSDF font atlas for grid labels
   */
  async loadFontAtlas(imageBitmap: ImageBitmap): Promise<void> {
    this.fontAtlasTexture.destroy();
    this.fontAtlasTexture = this.device.createTexture({
      size: [imageBitmap.width, imageBitmap.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture: this.fontAtlasTexture },
      [imageBitmap.width, imageBitmap.height]
    );
  }

  /**
   * Load cities MSDF font atlas
   */
  async loadCitiesFontAtlas(imageBitmap: ImageBitmap): Promise<void> {
    this.cityFontAtlasTexture.destroy();
    this.cityFontAtlasTexture = this.device.createTexture({
      size: [imageBitmap.width, imageBitmap.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture: this.cityFontAtlasTexture },
      [imageBitmap.width, imageBitmap.height]
    );
  }

  /**
   * Initialize cities AuroraLayer with pre-loaded data and register it.
   * Bind group entries for cityLookupTexture/cityDataBuffer/font atlas/sampler
   * stay host-owned (still part of the main bind group); the layer drives writes
   * and resizes through the host handle.
   */
  initCities(
    citiesDataBuffer: ArrayBuffer,
    metricsBuffer: ArrayBuffer,
    lodLevels: CitiesLodLevel[]
  ): void {
    const distance = this.camera.getState().distance;
    const fov = 2 * Math.atan(this.camera.getTanFov());
    const heightCss = this.canvas.height / this.dpr;
    const initialGlobeRadiusPx = Math.asin(1 / distance) * (heightCss / fov);

    const renderer = this;
    const host: CitiesAuroraLayerHost = {
      get cityLookupTexture() { return renderer.cityLookupTexture; },
      get cityDataBuffer() { return renderer.cityDataBuffer; },
      setCityDataBuffer(buf: GPUBuffer) { renderer.cityDataBuffer = buf; },
      uniformView: this.uniformView,
      recreateBindGroup() { renderer.recreateBindGroup(); },
    };

    this.layerRegistry.register(
      new CitiesAuroraLayer(initialGlobeRadiusPx, lodLevels, citiesDataBuffer, metricsBuffer, host),
      this.getLayerContext(),
    );
  }

  /**
   * Load logo texture for idle globe display
   */
  async loadLogo(imageBitmap: ImageBitmap): Promise<void> {
    this.logoTexture.destroy();
    this.logoTexture = this.device.createTexture({
      size: [imageBitmap.width, imageBitmap.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture: this.logoTexture },
      [imageBitmap.width, imageBitmap.height]
    );
  }

  /** Recreate main bind group (call after buffer/texture changes) */
  private recreateBindGroup(): void {
    const bindGroupLayout = this.pipeline.getBindGroupLayout(0);
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.uniformBuffer } },
      { binding: 1, resource: this.basemapTexture.createView({ dimension: 'cube' }) },
      { binding: 2, resource: this.basemapSampler },
      { binding: 3, resource: { buffer: this.gaussianGridBuffer } },
      // Bindings 5-10 available
      { binding: 11, resource: this.fontAtlasTexture.createView() },
      { binding: 12, resource: this.fontAtlasSampler },
      { binding: 13, resource: this.paletteTexture.texture.createView() },
      { binding: 14, resource: this.paletteTexture.sampler },
      // Bindings 15-18 removed (legacy weather data buffers)
      { binding: 19, resource: this.logoTexture.createView() },
      { binding: 20, resource: this.logoSampler },
      { binding: 21, resource: { buffer: this.graticuleLinesBuffer } },
      // Cities layer
      { binding: 22, resource: this.cityLookupTexture.createView() },
      { binding: 23, resource: { buffer: this.cityDataBuffer } },
      { binding: 25, resource: this.cityFontAtlasTexture.createView() },
      { binding: 26, resource: this.cityFontSampler },
    ];

    // Add dynamic param entries (placeholder until data loads, skip packed secondaries)
    for (const cfg of this.currentParamBindings) {
      if (cfg.packed) continue;
      if (cfg.bindingType === 'texture') {
        const texture = this.paramTextures.get(cfg.param) ?? this.placeholderParamTexture;  // QC-OK: GPU needs valid texture
        entries.push(
          { binding: cfg.bindingSlot, resource: texture.createView() }
        );
      } else {
        const buffer = this.paramBuffers.get(cfg.param) ?? this.placeholderBuffer;  // QC-OK: GPU needs valid buffer
        entries.push(
          { binding: cfg.bindingSlot, resource: { buffer } }
        );
      }
    }

    this.bindGroup = this.device.createBindGroup({ layout: bindGroupLayout, entries });
  }

  /**
   * Set wind layer buffers from LayerStore (U0, V0, U1, V1).
   * Forwards to WindAuroraLayer via the registry's onDataChanged surface.
   */
  setWindLayerBuffers(u0: GPUBuffer, v0: GPUBuffer, u1: GPUBuffer, v1: GPUBuffer): void {
    const events: AuroraDataEvent[] = [
      { param: 'wind_u_component_10m', buffer0: u0, buffer1: u1, lerp: 0 },
      { param: 'wind_v_component_10m', buffer0: v0, buffer1: v1, lerp: 0 },
    ];
    this.layerRegistry.onDataChanged('wind', events, this.getLayerContext());
  }

  /**
   * Set wind line/seed count (responds to wind.seedCount option changes).
   * Forwards to WindAuroraLayer via the registry's onOptionsChanged surface.
   */
  setWindSeedCount(seedCount: number): void {
    this.layerRegistry.onOptionsChanged('wind', { seedCount }, this.getLayerContext());
  }

  /**
   * Set combined param buffer (t0+t1 packed) for bind group creation
   * Called when active slots change for a param
   */
  setParamBuffer(param: string, buffer: GPUBuffer): void {
    this.paramBuffers.set(param, buffer);
    this.recreateBindGroup();
  }

  /**
   * Set combined param texture (t0+t1 packed vertically) for bind group creation
   * Called when active slots change for a texture-backed param
   */
  setParamTexture(param: string, texture: GPUTexture): void {
    this.paramTextures.set(param, texture);
    this.recreateBindGroup();
  }

  /**
   * Set param interpolation state (lerp factor and ready flag)
   */
  setParamState(paramIndex: number, lerp: number, ready: boolean): void {
    const lerpOffset = getParamLerpOffset(paramIndex);
    const readyOffset = getParamReadyOffset(paramIndex);
    this.uniformView.setFloat32(lerpOffset, lerp, true);
    this.uniformView.setUint32(readyOffset, ready ? 1 : 0, true);
  }

  /**
   * Set param slot spacing (seconds between t0 and t1)
   */
  setParamDt(paramIndex: number, dtSeconds: number): void {
    const offset = getParamDtOffset(paramIndex);
    this.uniformView.setFloat32(offset, dtSeconds, true);
  }

  /**
   * Set param grid point count (t1 offset in combined buffer)
   */
  setParamSize(paramIndex: number, gridPoints: number): void {
    const offset = getParamSizeOffset(paramIndex);
    this.uniformView.setUint32(offset, gridPoints, true);
  }

  /**
   * Create bind group layout with dynamic param entries
   */
  private createDynamicBindGroupLayout(): GPUBindGroupLayout {
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },  // gaussianGrid (packed)
      // Bindings 5-10 available
      { binding: 11, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // font atlas
      { binding: 12, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 13, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // palette array
      { binding: 14, visibility: GPUShaderStage.FRAGMENT, sampler: {} },  // palette sampler
      // Bindings 15-18 removed (legacy weather data buffers)
      { binding: 19, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // logo
      { binding: 20, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 21, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },  // graticule lines
      // Cities layer bindings
      { binding: 22, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },  // city lookup
      { binding: 23, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },  // city data (labels + glyphs)
      { binding: 25, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // city font atlas
      { binding: 26, visibility: GPUShaderStage.FRAGMENT, sampler: {} },  // city font sampler
    ];

    // Add dynamic param entries from activeParamBindings (skip packed secondaries — they share binding slot)
    for (const cfg of this.currentParamBindings) {
      if (cfg.packed) continue;
      if (cfg.bindingType === 'texture') {
        entries.push(
          { binding: cfg.bindingSlot, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }
        );
      } else {
        entries.push(
          { binding: cfg.bindingSlot, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }
        );
      }
    }

    return this.device.createBindGroupLayout({ entries });
  }

  /**
   * Initialize pressure layer with Gaussian LUTs (per-slot mode)
   * Call this once after Gaussian LUTs are uploaded
   */
  initializePressureLayer(): void {
    if (!this.pressureAuroraLayer.getInner().isComputeReady()) {
      this.pressureAuroraLayer.getInner().setExternalBuffers({
        gaussianGrid: this.gaussianGridBuffer,
      });
    }
  }

  /**
   * Trigger pressure regrid for a slot (per-slot mode)
   * @param slotIndex Grid slot index for output
   * @param inputBuffer Per-slot buffer containing O1280 raw data
   */
  triggerPressureRegrid(slotIndex: number, inputBuffer: GPUBuffer): void {
    // Initialize pressure layer if not done
    if (!this.pressureAuroraLayer.getInner().isComputeReady()) {
      this.initializePressureLayer();
    }
    this.pressureAuroraLayer.getInner().regridSlot(slotIndex, inputBuffer);
  }

  /**
   * Invalidate all pressure grid slots (called when slot indices are renumbered during shrink)
   */
  invalidatePressureGridSlots(): void {
    this.pressureAuroraLayer.getInner().invalidateAllGridSlots();
  }

  uploadGaussianLUTs(lats: Float32Array, offsets: Uint32Array): void {
    // Interleave as vec2<u32>: [latBits, offset] per ring
    const interleaved = new Uint32Array(lats.length * 2);
    const latBits = new Uint32Array(lats.buffer, lats.byteOffset, lats.length);
    for (let i = 0; i < lats.length; i++) {
      interleaved[i * 2] = latBits[i]!;
      interleaved[i * 2 + 1] = offsets[i]!;
    }
    this.device.queue.writeBuffer(this.gaussianGridBuffer, 0, interleaved);
  }

  /**
   * Set palette for a built-in layer by layer index and slot
   */
  setLayerPalette(layerIndex: number, slot: number, paletteId: PaletteId): void {
    const paletteIdx = this.paletteTexture.getPaletteIndex(paletteId);
    const offset = getLayerPaletteIndexOffset(layerIndex, slot);
    this.uniformView.setUint32(offset, paletteIdx, true);
  }

  /**
   * Set palette data range for a built-in layer by layer index
   */
  setLayerPaletteRange(layerIndex: number, min: number, max: number): void {
    const offset = getLayerPaletteRangeOffset(layerIndex);
    this.uniformView.setFloat32(offset, min, true);
    this.uniformView.setFloat32(offset + 4, max, true);
  }

  /**
   * Get palette texture for external access
   */
  getPaletteTexture(): PaletteTexture {
    return this.paletteTexture;
  }

  /** Get uniform DataView for declarative writers */
  getUniformView(): DataView {
    return this.uniformView;
  }

  /** Get GPU device for external buffer creation */
  getDevice(): GPUDevice {
    return this.device;
  }

  /** Read pixels directly from GPU texture — bypasses canvas compositor */
  async readbackFrame(): Promise<ImageBitmap> {
    return readbackFrameImpl(this.device, this.captureTexture, this.format);
  }

  /** Update level count (may resize vertex buffer) */
  setPressureLevelCount(levelCount: number): void {
    this.pressureAuroraLayer.getInner().setLevelCount(levelCount);
  }


  /**
   * Run contour compute for pressure with interpolation between two grid slots
   * @param slot0 First grid slot index
   * @param slot1 Second grid slot index (same as slot0 for single mode)
   * @param lerp Interpolation factor (0 = slot0, 1 = slot1)
   * @param levels Isobar levels to compute (hPa values)
   * @param smoothingIterations Number of smoothing passes (0-2)
   * @param smoothingAlgo Smoothing algorithm ('laplacian' or 'chaikin')
   */
  runPressureContour(
    slot0: number,
    slot1: number,
    lerp: number,
    levels: number[],
    smoothingIterations = 0
  ): void {
    if (!this.pressureAuroraLayer.getInner().isComputeReady()) {
      console.warn('[Globe] Pressure layer not ready');
      return;
    }

    // Check if grid slots are ready
    if (!this.pressureAuroraLayer.getInner().isGridSlotReady(slot0) || !this.pressureAuroraLayer.getInner().isGridSlotReady(slot1)) {
      console.warn(`[Globe] Grid slots not ready: ${slot0}=${this.pressureAuroraLayer.getInner().isGridSlotReady(slot0)}, ${slot1}=${this.pressureAuroraLayer.getInner().isGridSlotReady(slot1)}`);
      return;
    }

    // Base vertex count per level from marching squares
    const baseVerticesPerLevel = this.pressureAuroraLayer.getInner().getBaseVerticesPerLevel();
    // Chaikin 2× per pass, so max expansion is 2^iterations
    const expansionFactor = Math.pow(2, smoothingIterations);
    const maxVerticesPerLevel = baseVerticesPerLevel * expansionFactor;

    // Prepare batch: write all uniforms, clear buffers, cache bind group
    this.pressureAuroraLayer.getInner().prepareContourBatch(slot0, slot1, lerp, levels, maxVerticesPerLevel);

    // Batch all levels into a single command encoder
    const commandEncoder = this.device.createCommandEncoder();

    // Clear vertex buffer using GPU-side clearBuffer (include Chaikin expansion)
    this.pressureAuroraLayer.getInner().clearVertexBuffer(commandEncoder, expansionFactor);

    let totalVertices = 0;
    for (let i = 0; i < levels.length; i++) {
      // Run contour with dynamic uniform offset
      this.pressureAuroraLayer.getInner().runContourLevel(commandEncoder, i);

      // Run Chaikin smoothing passes if requested
      const vertexOffset = i * maxVerticesPerLevel;
      if (smoothingIterations > 0) {
        const newCount = this.pressureAuroraLayer.getInner().runSmoothing(
          commandEncoder,
          smoothingIterations,
          vertexOffset,
          baseVerticesPerLevel,
          i  // levelIndex for Chaikin dynamic uniforms
        );
        totalVertices += newCount;
      } else {
        totalVertices += baseVerticesPerLevel;
      }
    }

    // Single GPU submit for all levels
    this.device.queue.submit([commandEncoder.finish()]);
    this.pressureAuroraLayer.getInner().setVertexCount(totalVertices);
  }

  /** Aurora layer registry — Phase 1: empty. Real layers register here from Phase 2 onward. */
  getLayerRegistry(): AuroraLayerRegistry {
    return this.layerRegistry;
  }

  /** Build an AuroraLayerContext for register/onDataChanged/onOptionsChanged calls. */
  getLayerContext(): AuroraLayerContext {
    return {
      device: this.device,
      format: this.format,
      paletteTexture: this.paletteTexture,
      gaussianGridBuffer: this.gaussianGridBuffer,
      uniformBuffer: this.uniformBuffer,
    };
  }

  dispose(): void {
    this.layerRegistry.disposeAll();
    this.uniformBuffer?.destroy();
    this.basemapTexture?.destroy();
    this.gaussianGridBuffer?.destroy();
    this.placeholderBuffer?.destroy();
    this.fontAtlasTexture?.destroy();
    this.paletteTexture?.dispose();
    this.depthTexture?.destroy();
    this.colorTexture?.destroy();
    this.captureTexture?.destroy();
    this.gpuTimestamp?.dispose();
  }
}
