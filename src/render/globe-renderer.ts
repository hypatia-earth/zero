/**
 * GlobeRenderer - WebGPU globe rendering
 */

import { Camera, type CameraConfig } from './camera';
import shaderCode from './shaders/zero.wgsl?raw';
import postprocessShaderCode from './shaders/postprocess.wgsl?raw';
import { createAtmosphereLUTs, type AtmosphereLUTs, type AtmosphereLUTData } from './atmosphere-luts';
import { PressureLayer, type PressureResolution } from './pressure-layer';
import type { TWeatherTextureLayer } from '../config/types';

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
  earthOpacity: number;
  tempOpacity: number;
  rainOpacity: number;
  cloudsOpacity: number;
  humidityOpacity: number;
  windOpacity: number;
  pressureOpacity: number;
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
  private postProcessPipeline!: GPURenderPipeline;
  private postProcessBindGroup!: GPUBindGroup;
  private postProcessBindGroupLayout!: GPUBindGroupLayout;
  private colorSampler!: GPUSampler;

  readonly camera: Camera;
  private uniformData = new ArrayBuffer(384);  // Includes padding for vec2f alignment + weather layers
  private uniformView = new DataView(this.uniformData);

  // Track layer opacities for depth test decision
  private currentEarthOpacity = 0;

  // Timestamp queries for GPU timing
  private hasTimestampQuery = false;
  private timestampQuerySet: GPUQuerySet | null = null;
  private timestampBuffer: GPUBuffer | null = null;
  private timestampReadBuffers: [GPUBuffer, GPUBuffer] | null = null;
  private timestampPending: [boolean, boolean] = [false, false];  // Per-buffer pending state
  private lastGpuTimeMs: number | null = null;
  private currentTempOpacity = 0;

  constructor(private canvas: HTMLCanvasElement, cameraConfig?: CameraConfig) {
    this.camera = new Camera({ lat: 30, lon: 0, distance: 3 }, cameraConfig);
  }

  async initialize(requestedSlots: number, pressureResolution: PressureResolution = 2): Promise<void> {
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
    this.hasTimestampQuery = adapter.features.has('timestamp-query');

    const requiredFeatures: GPUFeatureName[] = [];
    if (hasFloat32Filterable) requiredFeatures.push('float32-filterable');
    if (this.hasTimestampQuery) requiredFeatures.push('timestamp-query');

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
    console.log('[Globe] Device ready, waiting for queue...');

    // Wait for device to be fully ready
    await this.device.queue.onSubmittedWorkDone();

    this.context = this.canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });

    // Create timestamp query resources if supported (using timestampWrites, spec-compliant)
    if (this.hasTimestampQuery) {
      this.timestampQuerySet = this.device.createQuerySet({
        type: 'timestamp',
        count: 2,  // beginning and end of pass
      });
      this.timestampBuffer = this.device.createBuffer({
        size: 16,  // 2 × BigInt64
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      // Double-buffer read buffers to avoid race between GPU copy and CPU read
      this.timestampReadBuffers = [
        this.device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        this.device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      ];
      console.log('[Globe] Timestamp queries enabled (timestampWrites)');
    } else {
      console.log('[Globe] Timestamp queries not available');
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
    console.log(`[Globe] Pressure resolution: ${pressureResolution}°`);

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
    let offset = 0;

    // mat4 viewProjInverse (64 bytes)
    for (let i = 0; i < 16; i++) {
      view.setFloat32(offset, uniforms.viewProjInverse[i]!, true);
      offset += 4;
    }

    // vec3 eyePosition + padding (16 bytes)
    view.setFloat32(offset, uniforms.eyePosition[0]!, true); offset += 4;
    view.setFloat32(offset, uniforms.eyePosition[1]!, true); offset += 4;
    view.setFloat32(offset, uniforms.eyePosition[2]!, true); offset += 4;
    offset += 4;

    // vec2 resolution + tanFov + padding (16 bytes)
    view.setFloat32(offset, uniforms.resolution[0]!, true); offset += 4;
    view.setFloat32(offset, uniforms.resolution[1]!, true); offset += 4;
    view.setFloat32(offset, uniforms.tanFov, true); offset += 4;
    offset += 4; // padding

    // time, sunOpacity + padding to align sunDirection to 16 bytes
    view.setFloat32(offset, uniforms.time, true); offset += 4;
    view.setFloat32(offset, uniforms.sunOpacity, true); offset += 4;
    offset += 8; // padding for vec3f alignment

    // vec3 sunDirection + padding (16 bytes)
    view.setFloat32(offset, uniforms.sunDirection[0]!, true); offset += 4;
    view.setFloat32(offset, uniforms.sunDirection[1]!, true); offset += 4;
    view.setFloat32(offset, uniforms.sunDirection[2]!, true); offset += 4;
    offset += 4;

    // sunCoreRadius, sunGlowRadius + padding (16 bytes)
    view.setFloat32(offset, uniforms.sunCoreRadius, true); offset += 4;
    view.setFloat32(offset, uniforms.sunGlowRadius, true); offset += 4;
    offset += 8; // padding

    // vec3 sunCoreColor + padding (16 bytes)
    view.setFloat32(offset, uniforms.sunCoreColor[0]!, true); offset += 4;
    view.setFloat32(offset, uniforms.sunCoreColor[1]!, true); offset += 4;
    view.setFloat32(offset, uniforms.sunCoreColor[2]!, true); offset += 4;
    offset += 4;

    // vec3 sunGlowColor + padding (16 bytes)
    view.setFloat32(offset, uniforms.sunGlowColor[0]!, true); offset += 4;
    view.setFloat32(offset, uniforms.sunGlowColor[1]!, true); offset += 4;
    view.setFloat32(offset, uniforms.sunGlowColor[2]!, true); offset += 4;
    offset += 4;

    // gridEnabled, gridOpacity, earthOpacity, tempOpacity
    view.setUint32(offset, uniforms.gridEnabled ? 1 : 0, true); offset += 4;
    view.setFloat32(offset, uniforms.gridOpacity, true); offset += 4;
    view.setFloat32(offset, uniforms.earthOpacity, true); offset += 4;
    view.setFloat32(offset, uniforms.tempOpacity, true); offset += 4;

    // Track for depth test decision in render()
    this.currentEarthOpacity = uniforms.earthOpacity;
    this.currentTempOpacity = uniforms.tempOpacity;

    // rainOpacity, tempDataReady, rainDataReady, tempLerp
    view.setFloat32(offset, uniforms.rainOpacity, true); offset += 4;
    view.setUint32(offset, uniforms.tempDataReady ? 1 : 0, true); offset += 4;
    view.setUint32(offset, uniforms.rainDataReady ? 1 : 0, true); offset += 4;
    view.setFloat32(offset, uniforms.tempLerp, true); offset += 4;

    // tempLoadedPoints, tempSlot0, tempSlot1, gridFontSize (16 bytes)
    view.setUint32(offset, uniforms.tempLoadedPoints, true); offset += 4;
    view.setUint32(offset, uniforms.tempSlot0, true); offset += 4;
    view.setUint32(offset, uniforms.tempSlot1, true); offset += 4;
    view.setFloat32(offset, uniforms.gridFontSize, true); offset += 4;

    // tempLoadedPad + extra padding for vec2f 8-byte alignment + tempPaletteRange
    offset += 4; // tempLoadedPad
    offset += 4; // extra padding for vec2f alignment
    view.setFloat32(offset, uniforms.tempPaletteRange[0]!, true); offset += 4;
    view.setFloat32(offset, uniforms.tempPaletteRange[1]!, true); offset += 4;

    // Additional weather layer opacities (32 bytes)
    view.setFloat32(offset, uniforms.cloudsOpacity, true); offset += 4;
    view.setFloat32(offset, uniforms.humidityOpacity, true); offset += 4;
    view.setFloat32(offset, uniforms.windOpacity, true); offset += 4;
    view.setUint32(offset, uniforms.cloudsDataReady ? 1 : 0, true); offset += 4;
    view.setUint32(offset, uniforms.humidityDataReady ? 1 : 0, true); offset += 4;
    view.setUint32(offset, uniforms.windDataReady ? 1 : 0, true); offset += 4;
    offset += 8; // weatherPad (vec2f)

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

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
      }, false);
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
    if (this.hasTimestampQuery && this.timestampQuerySet) {
      globePassDescriptor.timestampWrites = {
        querySet: this.timestampQuerySet,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      };
    }

    const globePass = commandEncoder.beginRenderPass(globePassDescriptor);

    globePass.setPipeline(this.pipeline);
    globePass.setBindGroup(0, this.bindGroup);
    globePass.draw(3);
    globePass.end();

    // PASS 2: Geometry layers (pressure contours, etc.)
    // Renders to same color/depth textures, depth-tested against globe
    if (this.pressureLayer.isEnabled() && this.pressureLayer.getVertexCount() > 0) {
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

      this.pressureLayer.render(geometryPass);
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

    // Resolve and copy timestamp queries (double-buffered: use whichever buffer is free)
    const hasTimestamp = this.hasTimestampQuery && this.timestampQuerySet &&
      this.timestampBuffer && this.timestampReadBuffers;
    // Find a free buffer (not pending mapAsync)
    const freeIdx: -1 | 0 | 1 = hasTimestamp ? (this.timestampPending[0] ? (this.timestampPending[1] ? -1 : 1) : 0) : -1;

    if (freeIdx === 0 || freeIdx === 1) {
      const idx = freeIdx;  // Capture narrowed type for closure
      const readBuffer = this.timestampReadBuffers![idx];
      commandEncoder.resolveQuerySet(this.timestampQuerySet!, 0, 2, this.timestampBuffer!, 0);
      commandEncoder.copyBufferToBuffer(this.timestampBuffer!, 0, readBuffer, 0, 16);

      this.device.queue.submit([commandEncoder.finish()]);

      // Start async readback for GPU timing
      this.timestampPending[idx] = true;
      readBuffer.mapAsync(GPUMapMode.READ).then(() => {
        const data = readBuffer.getMappedRange();
        const times = new BigUint64Array(data);
        const t0 = times[0]!, t1 = times[1]!;
        const durationNs = t1 > t0 ? Number(t1 - t0) : Number(t0 - t1);
        this.lastGpuTimeMs = durationNs / 1_000_000;
        readBuffer.unmap();
        this.timestampPending[idx] = false;
      }).catch(() => {
        this.timestampPending[idx] = false;
      });
    } else {
      this.device.queue.submit([commandEncoder.finish()]);
    }

    return this.lastGpuTimeMs;
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
    let totalVertices = 0;

    // Clear vertex buffer to remove stale geometry
    this.pressureLayer.clearVertexBuffer();

    for (let i = 0; i < levels.length; i++) {
      const vertexOffset = i * maxVerticesPerLevel;
      const commandEncoder = this.device.createCommandEncoder();
      const levelPa = levels[i]! * 100;  // Convert hPa to Pa
      this.pressureLayer.runContour(commandEncoder, slot0, slot1, lerp, levelPa, vertexOffset);

      // Run smoothing passes if requested
      if (smoothingIterations > 0) {
        this.pressureLayer.runSmoothing(commandEncoder, smoothingIterations, vertexOffset, maxVerticesPerLevel);
      }

      this.device.queue.submit([commandEncoder.finish()]);
      totalVertices += maxVerticesPerLevel;
    }

    this.pressureLayer.setVertexCount(totalVertices);
  }

  /**
   * Initialize pressure layer with synthetic O1280 data for testing
   * Generates lat-based pressure gradient: high at equator, low at poles
   */
  initSyntheticPressure(): void {
    // Generate synthetic O1280 pressure data
    const syntheticData = this.generateSyntheticO1280Pressure();

    // Create temporary buffer and upload synthetic data
    const syntheticBuffer = this.device.createBuffer({
      size: BYTES_PER_TIMESTEP,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'synthetic-pressure-data',
    });
    this.device.queue.writeBuffer(syntheticBuffer, 0, syntheticData.buffer, syntheticData.byteOffset, syntheticData.byteLength);

    // Trigger regrid with the synthetic buffer
    this.triggerPressureRegrid(0, syntheticBuffer);

    // Run contour with slot0=slot1 (single mode, no interpolation)
    const testLevels = [976, 984, 992, 1000, 1008, 1016];
    this.runPressureContour(0, 0, 0, testLevels);

    this.pressureLayer.setEnabled(true);
    console.log(`[Globe] Synthetic pressure: ${testLevels.length} levels`);

    // Note: syntheticBuffer is kept alive for re-regrid on resolution change
    // In production, LayerStore manages buffer lifecycle
  }

  /**
   * Generate synthetic O1280 pressure data
   * Base gradient + cyclone over Germany (51°N, 10°E)
   */
  private generateSyntheticO1280Pressure(): Float32Array {
    const data = new Float32Array(POINTS_PER_TIMESTEP);

    // Cyclone center - Germany (51°N, 10°E)
    // Formula: cycloneLon = (90 - targetLon) for O1280 grid offset
    const targetLat = 51, targetLon = 10;
    const cycloneLat = targetLat * Math.PI / 180;
    const cycloneLon = (90 - targetLon) * Math.PI / 180;
    const cycloneDepth = 40;  // hPa drop at center
    const cycloneRadius = 15 * Math.PI / 180;  // ~15° radius (~1500km)

    // O1280: 2560 rings, variable points per ring
    let idx = 0;
    for (let ring = 0; ring < 2560; ring++) {
      // Latitude: 90° at ring 0, -90° at ring 2559
      const latDeg = 90 - (ring + 0.5) * 180 / 2560;
      const lat = latDeg * Math.PI / 180;

      // Points in this ring
      const ringFromPole = ring < 1280 ? ring + 1 : 2560 - ring;
      const nPoints = 4 * ringFromPole + 16;

      for (let i = 0; i < nPoints; i++) {
        // Longitude for this point (O1280 starts at 0°)
        const lon = (i / nPoints) * 2 * Math.PI;  // 0 to 2π

        // Base pressure: higher at equator, lower at poles
        const basePressure = 1010 + 10 * Math.cos(Math.abs(lat));

        // Distance from cyclone center (great circle)
        const dLon = lon - cycloneLon;
        const cosD = Math.sin(cycloneLat) * Math.sin(lat) +
                     Math.cos(cycloneLat) * Math.cos(lat) * Math.cos(dLon);
        const dist = Math.acos(Math.max(-1, Math.min(1, cosD)));

        // Gaussian pressure drop for cyclone
        const cycloneEffect = cycloneDepth * Math.exp(-(dist * dist) / (2 * cycloneRadius * cycloneRadius));

        data[idx++] = basePressure - cycloneEffect;
      }
    }

    return data;
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
  }
}
