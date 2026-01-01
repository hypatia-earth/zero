/**
 * GlobeRenderer - WebGPU globe rendering
 */

import { Camera, type CameraConfig } from './camera';
import shaderCode from './shaders/zero-main.wgsl?raw';
import postprocessShaderCode from './shaders/zero-post.wgsl?raw';
import { createAtmosphereLUTs, type AtmosphereLUTs, type AtmosphereLUTData } from './atmosphere-luts';
import { PressureLayer, type PressureResolution } from './pressure-layer';
import { WindLayer } from './wind-layer';
import { GridAnimator, GRID_BUFFER_SIZE } from './grid-animator';
import { U, UNIFORM_BUFFER_SIZE } from './globe-uniforms';
import { GpuTimestamp } from './gpu-timestamp';
import type { TWeatherTextureLayer, LayerState } from '../config/types';
import { defaultConfig } from '../config/defaults';
import type { PressureColorOption } from '../schemas/options.schema';

export interface GlobeUniforms {
  viewProjInverse: Float32Array;
  eyePosition: Float32Array;
  resolution: Float32Array;
  time: number;
  tanFov: number;
  sunOpacity: number;
  sunDirection: Float32Array;
  sunCoreRadius: number;
  sunGlowRadius: number;
  sunCoreColor: Float32Array;
  sunGlowColor: Float32Array;
  gridEnabled: boolean;
  gridOpacity: number;
  gridFontSize: number;
  gridLabelMaxRadius: number;
  earthOpacity: number;
  tempOpacity: number;
  rainOpacity: number;
  cloudsOpacity: number;
  humidityOpacity: number;
  windOpacity: number;
  windLerp: number;
  windAnimSpeed: number;  // updates per second
  windState: LayerState;  // full state for compute caching
  pressureOpacity: number;
  pressureColors: PressureColorOption;
  tempDataReady: boolean;
  rainDataReady: boolean;
  cloudsDataReady: boolean;
  humidityDataReady: boolean;
  windDataReady: boolean;
  tempLerp: number;
  tempLoadedPoints: number;  // progressive loading: cells 0..N valid
  tempSlot0: number;         // slot index for time0 in large buffer
  tempSlot1: number;         // slot index for time1 in large buffer
  tempPaletteRange: Float32Array; // min/max temperature values for palette mapping
  logoOpacity: number;       // computed from all layer opacities
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
  private gaussianLatsBuffer!: GPUBuffer;
  private ringOffsetsBuffer!: GPUBuffer;
  private tempData0Buffer!: GPUBuffer;  // Slot 0 buffer (rebound on slot change)
  private tempData1Buffer!: GPUBuffer;  // Slot 1 buffer (rebound on slot change)
  private rainDataBuffer!: GPUBuffer;
  private cloudsDataBuffer!: GPUBuffer;
  private humidityDataBuffer!: GPUBuffer;
  private windDataBuffer!: GPUBuffer;
  private atmosphereLUTs!: AtmosphereLUTs;
  private useFloat16Luts = false;
  private format!: GPUTextureFormat;
  private fontAtlasTexture!: GPUTexture;
  private fontAtlasSampler!: GPUSampler;
  private tempPaletteTexture!: GPUTexture;
  private tempPaletteSampler!: GPUSampler;
  private logoTexture!: GPUTexture;
  private logoSampler!: GPUSampler;
  private depthTexture!: GPUTexture;
  // Post-process pass for atmosphere
  private colorTexture!: GPUTexture;
  // Pressure contour layer
  private pressureLayer!: PressureLayer;
  // Wind layer
  private windLayer!: WindLayer;
  // Grid animation
  private gridLinesBuffer!: GPUBuffer;
  private gridAnimator!: GridAnimator;
  private postProcessPipeline!: GPURenderPipeline;
  private postProcessBindGroup!: GPUBindGroup;
  private postProcessBindGroupLayout!: GPUBindGroupLayout;
  private colorSampler!: GPUSampler;

  readonly camera: Camera;
  private uniformData = new ArrayBuffer(UNIFORM_BUFFER_SIZE);
  private uniformView = new DataView(this.uniformData);

  // Track layer opacities for depth test decision
  private currentEarthOpacity = 0;
  private currentTempOpacity = 0;

  // Wind animation state
  private windAnimPhase = 0;
  private windSnakeLength = defaultConfig.wind.snakeLength;
  private windLineWidth = defaultConfig.wind.lineWidth;
  private windSegments = defaultConfig.wind.segmentsPerLine;
  private lastAnimTime = 0;

  // GPU timing
  private gpuTimestamp: GpuTimestamp | null = null;

  constructor(private canvas: HTMLCanvasElement, cameraConfig?: CameraConfig) {
    this.camera = new Camera({ lat: 30, lon: 0, distance: 3 }, cameraConfig);
  }

  async initialize(requestedSlots: number, pressureResolution: PressureResolution = 2, windLineCount = 8192): Promise<void> {
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

    this.device = await adapter.requestDevice({
      requiredFeatures,
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(adapterStorageLimit, cap),
        maxBufferSize: Math.min(adapterBufferLimit, cap),
      },
    });

    // Handle device loss
    this.device.lost.then((info) => {
      console.error('[Globe] WebGPU device lost:', info.message, info.reason);
    });

    // WORKAROUND for Chrome bug 469455157: GPU crash on reload
    // Explicitly destroy device before page unload to prevent SharedImage mailbox race
    const device = this.device;
    window.addEventListener('beforeunload', () => {
      console.log('[Globe] beforeunload: destroying device');
      device.destroy();
    });

    // Wait for device to be fully ready
    await this.device.queue.onSubmittedWorkDone();

    this.context = this.canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });

    // Create GPU timestamp helper if supported
    if (hasTimestampQuery) {
      this.gpuTimestamp = new GpuTimestamp(this.device);
    }

    this.uniformBuffer = this.device.createBuffer({
      size: 384,  // Includes padding for vec2f alignment + weather layers
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Placeholder basemap (1x1 cube texture)
    this.basemapTexture = this.device.createTexture({
      size: [1, 1, 6],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.basemapSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    // Gaussian grid LUTs
    const numRings = 2560;
    this.gaussianLatsBuffer = this.device.createBuffer({
      size: numRings * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.ringOffsetsBuffer = this.device.createBuffer({
      size: numRings * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // 4-byte placeholders: WebGPU bind groups require buffers at creation time.
    // finalize() creates bind groups before SlotService/LayerStore exist.
    // LayerStore replaces these via setTempSlotBuffers() → recreateBindGroup().
    this.tempData0Buffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.tempData1Buffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // 4-byte placeholder buffers for unimplemented texture layers
    // Real buffers come from LayerStore when slot-based loading is implemented
    this.rainDataBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.cloudsDataBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.humidityDataBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.windDataBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Grid lines buffer for animated LoD
    this.gridLinesBuffer = this.device.createBuffer({
      size: GRID_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Grid animator for LoD transitions (initialize at correct LoD for camera altitude)
    const initialAltitudeKm = (this.camera.getState().distance - 1.0) * 6371;
    this.gridAnimator = new GridAnimator(initialAltitudeKm);

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

    // Temperature palette texture (256x1 for 1D color lookup)
    this.tempPaletteTexture = this.device.createTexture({
      size: [256, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.tempPaletteSampler = this.device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
    });

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
    const dpr = window.devicePixelRatio;
    const texWidth = Math.floor(this.canvas.clientWidth * dpr);
    const texHeight = Math.floor(this.canvas.clientHeight * dpr);

    // Color texture (globe renders here, post-process reads)
    this.colorTexture = this.device.createTexture({
      size: [texWidth, texHeight],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

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

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },  // tempData0 (slot 0)
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },  // tempData1 (slot 1)
        // Atmosphere LUTs
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // transmittance (2D)
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },  // scattering (3D)
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // irradiance (2D)
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: {} },  // atmosphere sampler
        // Font atlas for grid labels
        { binding: 11, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 12, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        // Temperature palette
        { binding: 13, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 14, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        // Additional weather layers
        { binding: 15, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },  // cloudsData
        { binding: 16, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },  // humidityData
        { binding: 17, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },  // windData
        { binding: 18, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },  // rainData
        // Logo texture for idle globe
        { binding: 19, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 20, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        // Grid lines for animated LoD
        { binding: 21, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

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
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // irradiance
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    this.postProcessPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.postProcessBindGroupLayout] }),
      vertex: { module: postProcessModule, entryPoint: 'vs_main' },
      fragment: { module: postProcessModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });

    // Initialize pressure layer with configured resolution
    this.pressureLayer = new PressureLayer(this.device, this.format, pressureResolution);

    // Initialize wind layer (2K lines for debugging)
    this.windLayer = new WindLayer(this.device, this.format, windLineCount);

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
    // Globe pass bind group
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.basemapTexture.createView({ dimension: 'cube' }) },
        { binding: 2, resource: this.basemapSampler },
        { binding: 3, resource: { buffer: this.gaussianLatsBuffer } },
        { binding: 4, resource: { buffer: this.ringOffsetsBuffer } },
        { binding: 5, resource: { buffer: this.tempData0Buffer } },
        { binding: 6, resource: { buffer: this.tempData1Buffer } },
        // Atmosphere LUTs
        { binding: 7, resource: this.atmosphereLUTs.transmittance.createView() },
        { binding: 8, resource: this.atmosphereLUTs.scattering.createView() },
        { binding: 9, resource: this.atmosphereLUTs.irradiance.createView() },
        { binding: 10, resource: this.atmosphereLUTs.sampler },
        // Font atlas
        { binding: 11, resource: this.fontAtlasTexture.createView() },
        { binding: 12, resource: this.fontAtlasSampler },
        // Temperature palette
        { binding: 13, resource: this.tempPaletteTexture.createView() },
        { binding: 14, resource: this.tempPaletteSampler },
        // Additional weather layers
        { binding: 15, resource: { buffer: this.cloudsDataBuffer } },
        { binding: 16, resource: { buffer: this.humidityDataBuffer } },
        { binding: 17, resource: { buffer: this.windDataBuffer } },
        { binding: 18, resource: { buffer: this.rainDataBuffer } },
        { binding: 19, resource: this.logoTexture.createView() },
        { binding: 20, resource: this.logoSampler },
        { binding: 21, resource: { buffer: this.gridLinesBuffer } },
      ],
    });

    // Post-process bind group for atmosphere pass
    this.createPostProcessBindGroup();
  }

  /**
   * Get whether float16 LUTs should be used (determined during initialize)
   */
  getUseFloat16Luts(): boolean {
    return this.useFloat16Luts;
  }

  resize(): void {
    const dpr = window.devicePixelRatio;
    const width = Math.floor(this.canvas.clientWidth * dpr);
    const height = Math.floor(this.canvas.clientHeight * dpr);
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
        { binding: 6, resource: this.atmosphereLUTs.irradiance.createView() },
        { binding: 7, resource: this.atmosphereLUTs.sampler },
      ],
    });
  }

  updateUniforms(uniforms: GlobeUniforms): void {
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

    // time, sunOpacity
    view.setFloat32(O.time, uniforms.time, true);
    view.setFloat32(O.sunOpacity, uniforms.sunOpacity, true);

    // vec3 sunDirection
    view.setFloat32(O.sunDirection, uniforms.sunDirection[0]!, true);
    view.setFloat32(O.sunDirection + 4, uniforms.sunDirection[1]!, true);
    view.setFloat32(O.sunDirection + 8, uniforms.sunDirection[2]!, true);

    // sunCoreRadius, sunGlowRadius
    view.setFloat32(O.sunCoreRadius, uniforms.sunCoreRadius, true);
    view.setFloat32(O.sunGlowRadius, uniforms.sunGlowRadius, true);

    // vec3 sunCoreColor
    view.setFloat32(O.sunCoreColor, uniforms.sunCoreColor[0]!, true);
    view.setFloat32(O.sunCoreColor + 4, uniforms.sunCoreColor[1]!, true);
    view.setFloat32(O.sunCoreColor + 8, uniforms.sunCoreColor[2]!, true);

    // vec3 sunGlowColor
    view.setFloat32(O.sunGlowColor, uniforms.sunGlowColor[0]!, true);
    view.setFloat32(O.sunGlowColor + 4, uniforms.sunGlowColor[1]!, true);
    view.setFloat32(O.sunGlowColor + 8, uniforms.sunGlowColor[2]!, true);

    // Layer controls
    view.setUint32(O.gridEnabled, uniforms.gridEnabled ? 1 : 0, true);
    view.setFloat32(O.gridOpacity, uniforms.gridOpacity, true);
    view.setFloat32(O.earthOpacity, uniforms.earthOpacity, true);
    view.setFloat32(O.tempOpacity, uniforms.tempOpacity, true);

    // Track for depth test decision in render()
    this.currentEarthOpacity = uniforms.earthOpacity;
    this.currentTempOpacity = uniforms.tempOpacity;

    view.setFloat32(O.rainOpacity, uniforms.rainOpacity, true);
    view.setUint32(O.tempDataReady, uniforms.tempDataReady ? 1 : 0, true);
    view.setUint32(O.rainDataReady, uniforms.rainDataReady ? 1 : 0, true);
    view.setFloat32(O.tempLerp, uniforms.tempLerp, true);

    // Temp layer slots
    view.setUint32(O.tempLoadedPoints, uniforms.tempLoadedPoints, true);
    view.setUint32(O.tempSlot0, uniforms.tempSlot0, true);
    view.setUint32(O.tempSlot1, uniforms.tempSlot1, true);

    // Grid settings
    view.setFloat32(O.gridFontSize, uniforms.gridFontSize, true);
    view.setFloat32(O.gridLabelMaxRadius, uniforms.gridLabelMaxRadius, true);

    // vec2 tempPaletteRange (alignment handled by layout)
    view.setFloat32(O.tempPaletteRange, uniforms.tempPaletteRange[0]!, true);
    view.setFloat32(O.tempPaletteRange + 4, uniforms.tempPaletteRange[1]!, true);

    // Additional weather layers
    view.setFloat32(O.cloudsOpacity, uniforms.cloudsOpacity, true);
    view.setFloat32(O.humidityOpacity, uniforms.humidityOpacity, true);
    view.setFloat32(O.windOpacity, uniforms.windOpacity, true);
    view.setUint32(O.cloudsDataReady, uniforms.cloudsDataReady ? 1 : 0, true);
    view.setUint32(O.humidityDataReady, uniforms.humidityDataReady ? 1 : 0, true);
    view.setUint32(O.windDataReady, uniforms.windDataReady ? 1 : 0, true);

    // Logo
    view.setFloat32(O.logoOpacity, uniforms.logoOpacity, true);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    // Update grid animation based on camera altitude
    const cameraDistance = Math.sqrt(
      uniforms.eyePosition[0]! ** 2 +
      uniforms.eyePosition[1]! ** 2 +
      uniforms.eyePosition[2]! ** 2
    );
    const altitudeKm = (cameraDistance - 1.0) * 6371;
    const gridBuffer = this.gridAnimator.packToBuffer(altitudeKm, 16);
    this.device.queue.writeBuffer(this.gridLinesBuffer, 0, gridBuffer);

    // Update pressure layer based on opacity
    const pressureVisible = uniforms.pressureOpacity > 0.01;
    this.pressureLayer.setEnabled(pressureVisible);

    if (pressureVisible) {
      this.pressureLayer.updateUniforms({
        viewProj: this.camera.getViewProj(),
        eyePosition: [
          uniforms.eyePosition[0]!,
          uniforms.eyePosition[1]!,
          uniforms.eyePosition[2]!,
        ],
        sunDirection: [
          uniforms.sunDirection[0]!,
          uniforms.sunDirection[1]!,
          uniforms.sunDirection[2]!,
        ],
        opacity: uniforms.pressureOpacity,
      }, uniforms.pressureColors);
    }

    // Update wind layer based on opacity AND data readiness
    // Don't run compute/render if buffers might be invalid
    const windVisible = uniforms.windOpacity > 0.01 && uniforms.windDataReady;
    this.windLayer.setEnabled(windVisible);

    if (windVisible) {
      // Advance snake animation phase
      // Convert updates/sec to cycles/sec: cycles = updates / segments
      const cyclesPerSec = uniforms.windAnimSpeed / this.windSegments;
      const now = performance.now() / 1000;
      if (this.lastAnimTime > 0) {
        const dt = now - this.lastAnimTime;
        this.windAnimPhase = (this.windAnimPhase + dt * cyclesPerSec) % 1;
      }
      this.lastAnimTime = now;

      // Update layer state (triggers compute when state changes)
      this.windLayer.setState(uniforms.windState);

      // Show backface when no texture layers are visible (transparent globe)
      const textureOpacity = uniforms.earthOpacity + uniforms.tempOpacity +
        uniforms.rainOpacity + uniforms.cloudsOpacity + uniforms.humidityOpacity;
      const showBackface = textureOpacity < 0.01 ? 1.0 : 0.0;

      this.windLayer.updateUniforms({
        viewProj: this.camera.getViewProj(),
        eyePosition: [
          uniforms.eyePosition[0]!,
          uniforms.eyePosition[1]!,
          uniforms.eyePosition[2]!,
        ],
        opacity: uniforms.windOpacity,
        animPhase: this.windAnimPhase,
        snakeLength: this.windSnakeLength,
        lineWidth: this.windLineWidth,
        showBackface,
      });
    }
  }

  render(): number | null {
    const commandEncoder = this.device.createCommandEncoder();

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
      globePassDescriptor.timestampWrites = this.gpuTimestamp.getTimestampWrites();
    }

    const globePass = commandEncoder.beginRenderPass(globePassDescriptor);

    globePass.setPipeline(this.pipeline);
    globePass.setBindGroup(0, this.bindGroup);
    globePass.draw(3);
    globePass.end();

    // COMPUTE PASS: Wind line tracing (runs before geometry rendering)
    const hasWind = this.windLayer.isEnabled();
    if (hasWind) {
      this.windLayer.runCompute(commandEncoder);
    }

    // PASS 2: Geometry layers (pressure contours, wind, etc.)
    // Renders to same color/depth textures, depth-tested against globe
    const hasPressure = this.pressureLayer.isEnabled() && this.pressureLayer.getVertexCount() > 0;

    if (hasPressure || hasWind) {
      // Use depth test only when earth or temp layers are visible
      const useGlobeDepth = this.currentEarthOpacity > 0.01 || this.currentTempOpacity > 0.01;

      const geometryPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: this.colorTexture.createView(),
          loadOp: 'load',  // Preserve globe render
          storeOp: 'store',
        }],
        depthStencilAttachment: {
          view: this.depthTexture.createView(),
          depthClearValue: 1.0,
          depthLoadOp: useGlobeDepth ? 'load' : 'clear',  // Clear = render full geometry
          depthStoreOp: 'store',
        },
      });

      if (hasPressure) {
        this.pressureLayer.render(geometryPass);
      }

      if (hasWind) {
        this.windLayer.render(geometryPass);
      }

      geometryPass.end();
    }

    // PASS 3: Post-process - apply atmosphere to final output
    const canvasView = this.context.getCurrentTexture().createView();
    const postProcessPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: canvasView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    postProcessPass.setPipeline(this.postProcessPipeline);
    postProcessPass.setBindGroup(0, this.postProcessBindGroup);
    postProcessPass.draw(3);
    postProcessPass.end();

    // Encode timestamp resolve commands BEFORE submit
    if (this.gpuTimestamp) {
      this.gpuTimestamp.encodeResolve(commandEncoder);
    }

    this.device.queue.submit([commandEncoder.finish()]);

    // Start async readback AFTER submit (critical ordering)
    if (this.gpuTimestamp) {
      this.gpuTimestamp.startReadback();
    }

    return this.gpuTimestamp?.getLastTimeMs() ?? null;
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
    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.basemapTexture.createView({ dimension: 'cube' }) },
        { binding: 2, resource: this.basemapSampler },
        { binding: 3, resource: { buffer: this.gaussianLatsBuffer } },
        { binding: 4, resource: { buffer: this.ringOffsetsBuffer } },
        { binding: 5, resource: { buffer: this.tempData0Buffer } },
        { binding: 6, resource: { buffer: this.tempData1Buffer } },
        { binding: 7, resource: this.atmosphereLUTs.transmittance.createView() },
        { binding: 8, resource: this.atmosphereLUTs.scattering.createView() },
        { binding: 9, resource: this.atmosphereLUTs.irradiance.createView() },
        { binding: 10, resource: this.atmosphereLUTs.sampler },
        { binding: 11, resource: this.fontAtlasTexture.createView() },
        { binding: 12, resource: this.fontAtlasSampler },
        { binding: 13, resource: this.tempPaletteTexture.createView() },
        { binding: 14, resource: this.tempPaletteSampler },
        { binding: 15, resource: { buffer: this.cloudsDataBuffer } },
        { binding: 16, resource: { buffer: this.humidityDataBuffer } },
        { binding: 17, resource: { buffer: this.windDataBuffer } },
        { binding: 18, resource: { buffer: this.rainDataBuffer } },
        { binding: 19, resource: this.logoTexture.createView() },
        { binding: 20, resource: this.logoSampler },
        { binding: 21, resource: { buffer: this.gridLinesBuffer } },
      ],
    });
  }

  /**
   * Set texture layer slot buffers (owned by LayerStore)
   * Replaces internal placeholders and recreates bind groups
   * Called when active slots change for texture-sampled layers (rebind)
   */
  setTextureLayerBuffers(param: TWeatherTextureLayer, buffer0: GPUBuffer, buffer1: GPUBuffer): void {
    switch (param) {
      case 'temp':
        this.tempData0Buffer = buffer0;
        this.tempData1Buffer = buffer1;
        break;
      // TODO: Add rain/clouds/humidity when per-slot + interpolation is implemented
      default:
        console.warn(`[Globe] setTextureLayerBuffers not implemented for ${param}`);
        return;
    }
    this.recreateBindGroup();
  }

  /**
   * Set wind layer buffers from LayerStore (U0, V0, U1, V1)
   * Called when active slots change
   */
  setWindLayerBuffers(u0: GPUBuffer, v0: GPUBuffer, u1: GPUBuffer, v1: GPUBuffer): void {
    this.windLayer.setExternalBuffers(u0, v0, u1, v1, this.gaussianLatsBuffer, this.ringOffsetsBuffer);
  }

  /**
   * Initialize pressure layer with Gaussian LUTs (per-slot mode)
   * Call this once after Gaussian LUTs are uploaded
   */
  initializePressureLayer(): void {
    if (!this.pressureLayer.isComputeReady()) {
      this.pressureLayer.setExternalBuffers({
        gaussianLats: this.gaussianLatsBuffer,
        ringOffsets: this.ringOffsetsBuffer,
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
    if (!this.pressureLayer.isComputeReady()) {
      this.initializePressureLayer();
    }
    this.pressureLayer.regridSlot(slotIndex, inputBuffer);
  }

  uploadGaussianLUTs(lats: Float32Array, offsets: Uint32Array): void {
    this.device.queue.writeBuffer(this.gaussianLatsBuffer, 0, lats.buffer, lats.byteOffset, lats.byteLength);
    this.device.queue.writeBuffer(this.ringOffsetsBuffer, 0, offsets.buffer, offsets.byteOffset, offsets.byteLength);
  }

  /**
   * Update temperature palette texture data
   * @param colors Array of RGB colors (256 colors x 4 components RGBA, 1024 bytes total)
   */
  updateTempPalette(colors: Uint8Array): void {
    if (colors.length !== 256 * 4) {
      throw new Error(`Expected 1024 bytes (256 RGBA colors), got ${colors.length}`);
    }
    this.device.queue.writeTexture(
      { texture: this.tempPaletteTexture },
      colors as Uint8Array<ArrayBuffer>,  // WebGPU requires ArrayBuffer, not ArrayBufferLike
      { bytesPerRow: 256 * 4 },
      [256, 1]
    );
  }

  /**
   * Upload temperature data directly to a buffer
   * In new architecture, each timeslot has its own buffer (no offset needed)
   * @param data Float32Array of temperature values (6.6M points)
   * @param buffer Target GPUBuffer to write to
   */
  uploadTempDataToBuffer(data: Float32Array, buffer: GPUBuffer): void {
    this.device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
  }

  /**
   * Upload partial temp data chunk to a buffer at offset (for progressive loading)
   * @param data Float32Array chunk
   * @param buffer Target GPUBuffer
   * @param pointOffset Offset in points (not bytes)
   */
  uploadTempDataChunkToBuffer(data: Float32Array, buffer: GPUBuffer, pointOffset: number): void {
    const byteOffset = pointOffset * 4;
    this.device.queue.writeBuffer(buffer, byteOffset, data.buffer, data.byteOffset, data.byteLength);
  }

  uploadRainData(data: Float32Array, offset: number = 0): void {
    this.device.queue.writeBuffer(this.rainDataBuffer, offset, data.buffer, data.byteOffset, data.byteLength);
  }

  uploadCloudsData(data: Float32Array, offset: number = 0): void {
    this.device.queue.writeBuffer(this.cloudsDataBuffer, offset, data.buffer, data.byteOffset, data.byteLength);
  }

  uploadHumidityData(data: Float32Array, offset: number = 0): void {
    this.device.queue.writeBuffer(this.humidityDataBuffer, offset, data.buffer, data.byteOffset, data.byteLength);
  }

  uploadWindData(data: Float32Array, offset: number = 0): void {
    this.device.queue.writeBuffer(this.windDataBuffer, offset, data.buffer, data.byteOffset, data.byteLength);
  }

  /** Get pressure layer for external control */
  getPressureLayer(): PressureLayer {
    return this.pressureLayer;
  }

  /** Get wind layer for external control */
  getWindLayer(): WindLayer {
    return this.windLayer;
  }

  /** Get GPU device for external buffer creation */
  getDevice(): GPUDevice {
    return this.device;
  }

  /** Change pressure resolution live, returns slots needing regrid */
  setPressureResolution(resolution: PressureResolution): number[] {
    return this.pressureLayer.setResolution(resolution);
  }

  /** Update level count (may resize vertex buffer) */
  setPressureLevelCount(levelCount: number): void {
    this.pressureLayer.setLevelCount(levelCount);
  }


  /**
   * Run contour compute for pressure with interpolation between two grid slots
   * @param slot0 First grid slot index
   * @param slot1 Second grid slot index (same as slot0 for single mode)
   * @param lerp Interpolation factor (0 = slot0, 1 = slot1)
   * @param levels Isobar levels to compute (hPa values)
   * @param smoothingIterations Number of Chaikin smoothing passes (0-2)
   */
  runPressureContour(slot0: number, slot1: number, lerp: number, levels: number[], smoothingIterations = 0): void {
    if (!this.pressureLayer.isComputeReady()) {
      console.warn('[Globe] Pressure layer not ready');
      return;
    }

    // Check if grid slots are ready
    if (!this.pressureLayer.isGridSlotReady(slot0) || !this.pressureLayer.isGridSlotReady(slot1)) {
      console.warn(`[Globe] Grid slots not ready: ${slot0}=${this.pressureLayer.isGridSlotReady(slot0)}, ${slot1}=${this.pressureLayer.isGridSlotReady(slot1)}`);
      return;
    }

    const maxVerticesPerLevel = 63724;

    // Prepare batch: write all uniforms, clear buffers, cache bind group
    this.pressureLayer.prepareContourBatch(slot0, slot1, lerp, levels, maxVerticesPerLevel);

    // Batch all levels into a single command encoder
    const commandEncoder = this.device.createCommandEncoder();

    // Clear vertex buffer using GPU-side clearBuffer
    this.pressureLayer.clearVertexBuffer(commandEncoder);

    for (let i = 0; i < levels.length; i++) {
      // Run contour with dynamic uniform offset
      this.pressureLayer.runContourLevel(commandEncoder, i);

      // Run smoothing passes if requested
      if (smoothingIterations > 0) {
        const vertexOffset = i * maxVerticesPerLevel;
        this.pressureLayer.runSmoothing(commandEncoder, smoothingIterations, vertexOffset, maxVerticesPerLevel);
      }
    }

    // Single GPU submit for all levels
    this.device.queue.submit([commandEncoder.finish()]);
    this.pressureLayer.setVertexCount(levels.length * maxVerticesPerLevel);
  }

  dispose(): void {
    this.uniformBuffer?.destroy();
    this.basemapTexture?.destroy();
    this.gaussianLatsBuffer?.destroy();
    this.ringOffsetsBuffer?.destroy();
    this.tempData0Buffer?.destroy();
    this.tempData1Buffer?.destroy();
    this.rainDataBuffer?.destroy();
    this.cloudsDataBuffer?.destroy();
    this.humidityDataBuffer?.destroy();
    this.windDataBuffer?.destroy();
    this.fontAtlasTexture?.destroy();
    this.tempPaletteTexture?.destroy();
    this.depthTexture?.destroy();
    this.colorTexture?.destroy();
    this.pressureLayer?.dispose();
    this.windLayer?.dispose();
    this.gpuTimestamp?.dispose();
  }
}
