/**
 * GlobeRenderer - WebGPU globe rendering
 */

import { Camera, type CameraConfig } from './camera';
import shaderCode from './shaders/zero.wgsl?raw';
import { createAtmosphereLUTs, type AtmosphereLUTs, type AtmosphereLUTData } from './atmosphere-luts';

export interface GlobeUniforms {
  viewProjInverse: Float32Array;
  eyePosition: Float32Array;
  resolution: Float32Array;
  time: number;
  tanFov: number;
  sunEnabled: boolean;
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
  tempDataReady: boolean;
  rainDataReady: boolean;
  tempLerp: number;
  tempLoadedPoints: number;  // progressive loading: cells 0..N valid
  tempSlot0: number;         // slot index for time0 in large buffer
  tempSlot1: number;         // slot index for time1 in large buffer
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
  private tempDataBuffer!: GPUBuffer;  // Single large buffer with slots
  private rainDataBuffer!: GPUBuffer;
  private maxTempSlots!: number;
  private atmosphereLUTs!: AtmosphereLUTs;
  private useFloat16Luts = false;
  private format!: GPUTextureFormat;
  private fontAtlasTexture!: GPUTexture;
  private fontAtlasSampler!: GPUSampler;

  readonly camera: Camera;
  private uniformData = new ArrayBuffer(336);  // Increased for new uniforms
  private uniformView = new DataView(this.uniformData);

  constructor(private canvas: HTMLCanvasElement, cameraConfig?: CameraConfig) {
    this.camera = new Camera({ lat: 30, lon: 0, distance: 3 }, cameraConfig);
  }

  async initialize(requestedSlots: number): Promise<void> {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter found');

    // Request higher limits (defaults are only 128-256 MB)
    const adapterStorageLimit = adapter.limits.maxStorageBufferBindingSize;
    const adapterBufferLimit = adapter.limits.maxBufferSize;
    const cap = 2 * 1024 * 1024 * 1024; // Cap at 2 GB

    // Check for float32-filterable support (use float16 LUTs if not available)
    const hasFloat32Filterable = adapter.features.has('float32-filterable');
    this.useFloat16Luts = !hasFloat32Filterable;

    const requiredFeatures: GPUFeatureName[] = hasFloat32Filterable ? ['float32-filterable'] : [];

    this.device = await adapter.requestDevice({
      requiredFeatures,
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(adapterStorageLimit, cap),
        maxBufferSize: Math.min(adapterBufferLimit, cap),
      },
    });

    const storageLimit = this.device.limits.maxStorageBufferBindingSize;
    const bufferLimit = this.device.limits.maxBufferSize;
    const effectiveLimit = Math.min(storageLimit, bufferLimit);
    console.log(`[GlobeRenderer] Buffer limits: storage=${(storageLimit / 1024 / 1024).toFixed(0)} MB, buffer=${(bufferLimit / 1024 / 1024).toFixed(0)} MB`);

    // Cap slots to what GPU can handle
    const maxSlotsFromGpu = Math.floor(effectiveLimit / BYTES_PER_TIMESTEP);
    this.maxTempSlots = Math.min(requestedSlots, maxSlotsFromGpu);

    // Handle device loss
    this.device.lost.then((info) => {
      console.error('[GlobeRenderer] WebGPU device lost:', info.message, info.reason);
    });
    console.log('[GlobeRenderer] Device ready, waiting for queue...');

    // Wait for device to be fully ready
    await this.device.queue.onSubmittedWorkDone();

    this.context = this.canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });

    this.uniformBuffer = this.device.createBuffer({
      size: 336,  // Increased for tempSlot0, tempSlot1
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

    // Weather data: single large buffer with N slots (default 7 slots = ~185 MB)
    const tempBufferSize = BYTES_PER_TIMESTEP * this.maxTempSlots;
    this.tempDataBuffer = this.device.createBuffer({
      size: tempBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    console.log(`[GlobeRenderer] Temp buffer: ${this.maxTempSlots} slots, ${(tempBufferSize / 1024 / 1024).toFixed(1)} MB`);

    // Rain data (single timestep for now)
    this.rainDataBuffer = this.device.createBuffer({
      size: BYTES_PER_TIMESTEP,
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

    // Shader code is pre-processed by wgsl-plus (see vite.config.ts)
    const shaderModule = this.device.createShaderModule({ code: shaderCode });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },  // tempData (large, slotted)
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },  // rainData
        // Atmosphere LUTs
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // transmittance (2D)
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },  // scattering (3D)
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // irradiance (2D)
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: {} },  // atmosphere sampler
        // Font atlas for grid labels
        { binding: 11, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 12, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });

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
   * Finalize renderer setup - creates bind group after all textures are loaded
   * Must be called after createAtmosphereTextures() and loadBasemap()
   */
  finalize(): void {
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.basemapTexture.createView({ dimension: 'cube' }) },
        { binding: 2, resource: this.basemapSampler },
        { binding: 3, resource: { buffer: this.gaussianLatsBuffer } },
        { binding: 4, resource: { buffer: this.ringOffsetsBuffer } },
        { binding: 5, resource: { buffer: this.tempDataBuffer } },
        { binding: 6, resource: { buffer: this.rainDataBuffer } },
        // Atmosphere LUTs
        { binding: 7, resource: this.atmosphereLUTs.transmittance.createView() },
        { binding: 8, resource: this.atmosphereLUTs.scattering.createView() },
        { binding: 9, resource: this.atmosphereLUTs.irradiance.createView() },
        { binding: 10, resource: this.atmosphereLUTs.sampler },
        // Font atlas
        { binding: 11, resource: this.fontAtlasTexture.createView() },
        { binding: 12, resource: this.fontAtlasSampler },
      ],
    });
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

    // time, sunEnabled + padding to align sunDirection to 16 bytes
    view.setFloat32(offset, uniforms.time, true); offset += 4;
    view.setUint32(offset, uniforms.sunEnabled ? 1 : 0, true); offset += 4;
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

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
  }

  render(): void {
    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.086, g: 0.086, b: 0.086, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.draw(3);
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);
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

    // Recreate bind group
    const bindGroupLayout = this.pipeline.getBindGroupLayout(0);
    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.basemapTexture.createView({ dimension: 'cube' }) },
        { binding: 2, resource: this.basemapSampler },
        { binding: 3, resource: { buffer: this.gaussianLatsBuffer } },
        { binding: 4, resource: { buffer: this.ringOffsetsBuffer } },
        { binding: 5, resource: { buffer: this.tempDataBuffer } },
        { binding: 6, resource: { buffer: this.rainDataBuffer } },
        // Atmosphere LUTs
        { binding: 7, resource: this.atmosphereLUTs.transmittance.createView() },
        { binding: 8, resource: this.atmosphereLUTs.scattering.createView() },
        { binding: 9, resource: this.atmosphereLUTs.irradiance.createView() },
        { binding: 10, resource: this.atmosphereLUTs.sampler },
        // Font atlas
        { binding: 11, resource: this.fontAtlasTexture.createView() },
        { binding: 12, resource: this.fontAtlasSampler },
      ],
    });
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

  uploadGaussianLUTs(lats: Float32Array, offsets: Uint32Array): void {
    this.device.queue.writeBuffer(this.gaussianLatsBuffer, 0, lats.buffer, lats.byteOffset, lats.byteLength);
    this.device.queue.writeBuffer(this.ringOffsetsBuffer, 0, offsets.buffer, offsets.byteOffset, offsets.byteLength);
  }

  /**
   * Upload temp data to a specific slot in the large buffer
   * @param data The temperature data array
   * @param slotIndex Which slot to write to (0..maxSlots-1)
   */
  async uploadTempDataToSlot(data: Float32Array, slotIndex: number): Promise<void> {
    if (slotIndex < 0 || slotIndex >= this.maxTempSlots) {
      throw new Error(`Invalid slot index ${slotIndex}, max is ${this.maxTempSlots - 1}`);
    }
    const byteOffset = slotIndex * BYTES_PER_TIMESTEP;
    this.device.queue.writeBuffer(this.tempDataBuffer, byteOffset, data.buffer, data.byteOffset, data.byteLength);
    await this.device.queue.onSubmittedWorkDone();
  }

  /**
   * Upload temp data to two adjacent slots (for backwards compatibility during transition)
   * Writes data0 to slot 0, data1 to slot 1
   */
  async uploadTempData(data0: Float32Array, data1: Float32Array): Promise<void> {
    this.device.queue.writeBuffer(this.tempDataBuffer, 0, data0.buffer, data0.byteOffset, data0.byteLength);
    this.device.queue.writeBuffer(this.tempDataBuffer, BYTES_PER_TIMESTEP, data1.buffer, data1.byteOffset, data1.byteLength);
    await this.device.queue.onSubmittedWorkDone();
    await new Promise(r => setTimeout(r, 100)); // Debug delay
  }

  /**
   * Upload partial temp data chunk to a slot at offset (for progressive loading)
   */
  uploadTempDataChunkToSlot(data: Float32Array, slotIndex: number, pointOffset: number): void {
    const byteOffset = slotIndex * BYTES_PER_TIMESTEP + pointOffset * 4;
    this.device.queue.writeBuffer(this.tempDataBuffer, byteOffset, data.buffer, data.byteOffset, data.byteLength);
  }

  uploadRainData(data: Float32Array, offset: number = 0): void {
    this.device.queue.writeBuffer(this.rainDataBuffer, offset, data.buffer, data.byteOffset, data.byteLength);
  }

  /**
   * Get the maximum number of temp slots available
   */
  getMaxTempSlots(): number {
    return this.maxTempSlots;
  }

  /**
   * Set max slots (must be called before initialize)
   */
  setMaxTempSlots(slots: number): void {
    this.maxTempSlots = slots;
  }

  dispose(): void {
    this.uniformBuffer?.destroy();
    this.basemapTexture?.destroy();
    this.gaussianLatsBuffer?.destroy();
    this.ringOffsetsBuffer?.destroy();
    this.tempDataBuffer?.destroy();
    this.rainDataBuffer?.destroy();
    this.fontAtlasTexture?.destroy();
  }
}
