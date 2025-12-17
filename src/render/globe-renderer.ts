/**
 * GlobeRenderer - WebGPU globe rendering
 */

import { Camera, type CameraConfig } from './camera';
import shaderCode from './shaders/zero.wgsl?raw';
import postprocessShaderCode from './shaders/postprocess.wgsl?raw';
import { createAtmosphereLUTs, type AtmosphereLUTs, type AtmosphereLUTData } from './atmosphere-luts';
import { PressureLayer } from './pressure-layer';

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
  tempDataReady: boolean;
  rainDataReady: boolean;
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
  private tempDataBuffer!: GPUBuffer;  // Single large buffer with slots
  private rainDataBuffer!: GPUBuffer;
  private maxTempSlots!: number;
  private atmosphereLUTs!: AtmosphereLUTs;
  private useFloat16Luts = false;
  private format!: GPUTextureFormat;
  private fontAtlasTexture!: GPUTexture;
  private fontAtlasSampler!: GPUSampler;
  private tempPaletteTexture!: GPUTexture;
  private tempPaletteSampler!: GPUSampler;
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
  private uniformData = new ArrayBuffer(352);  // Includes padding for vec2f alignment
  private uniformView = new DataView(this.uniformData);

  constructor(private canvas: HTMLCanvasElement, cameraConfig?: CameraConfig) {
    this.camera = new Camera({ lat: 30, lon: 0, distance: 3 }, cameraConfig);
  }

  async initialize(requestedSlots: number): Promise<void> {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter found');

    // Request higher limits based on requested slots
    const adapterStorageLimit = adapter.limits.maxStorageBufferBindingSize;
    const adapterBufferLimit = adapter.limits.maxBufferSize;
    const cap = requestedSlots * BYTES_PER_TIMESTEP;

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

    // Cap slots to what GPU can handle
    const effectiveLimit = Math.min(
      this.device.limits.maxStorageBufferBindingSize,
      this.device.limits.maxBufferSize
    );
    const maxSlotsFromGpu = Math.floor(effectiveLimit / BYTES_PER_TIMESTEP);
    this.maxTempSlots = Math.min(requestedSlots, maxSlotsFromGpu);

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

    this.uniformBuffer = this.device.createBuffer({
      size: 352,  // Includes padding for vec2f alignment
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

    // TODO: Should respect activated layers and varying size
    // Weather data: single large buffer with N slots (default 7 slots = ~185 MB)
    const tempBufferSize = BYTES_PER_TIMESTEP * this.maxTempSlots;
    this.tempDataBuffer = this.device.createBuffer({
      size: tempBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    console.log(`[Globe] Temp buffer: ${this.maxTempSlots} slots, ${(tempBufferSize / 1024 / 1024).toFixed(1)} MB`);

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
        // Temperature palette
        { binding: 13, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 14, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
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

    // Initialize pressure layer (default 2° resolution)
    this.pressureLayer = new PressureLayer(this.device, this.format, 2);
    // Enable with test contour for visual debugging
    this.initTestPressureContour();

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
        // Temperature palette
        { binding: 13, resource: this.tempPaletteTexture.createView() },
        { binding: 14, resource: this.tempPaletteSampler },
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

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    // Update pressure layer uniforms if enabled
    if (this.pressureLayer?.isEnabled()) {
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
        opacity: 0.85,  // TODO: get from options
      }, false);
    }
  }

  render(): void {
    const commandEncoder = this.device.createCommandEncoder();

    // PASS 1: Render globe to offscreen textures (no atmosphere)
    const globePass = commandEncoder.beginRenderPass({
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
    });

    globePass.setPipeline(this.pipeline);
    globePass.setBindGroup(0, this.bindGroup);
    globePass.draw(3);
    globePass.end();

    // PASS 2: Geometry layers (pressure contours, etc.)
    // Renders to same color/depth textures, depth-tested against globe
    if (this.pressureLayer.isEnabled() && this.pressureLayer.getVertexCount() > 0) {
      const geometryPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: this.colorTexture.createView(),
          loadOp: 'load',  // Preserve globe render
          storeOp: 'store',
        }],
        depthStencilAttachment: {
          view: this.depthTexture.createView(),
          depthLoadOp: 'load',  // Preserve globe depth
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
        // Temperature palette
        { binding: 13, resource: this.tempPaletteTexture.createView() },
        { binding: 14, resource: this.tempPaletteSampler },
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
   * Update temperature palette texture data
   * @param colors Array of RGB colors (256 colors x 4 components RGBA, 1024 bytes total)
   */
  updateTempPalette(colors: Uint8Array<ArrayBuffer>): void {
    if (colors.length !== 256 * 4) {
      throw new Error(`Expected 1024 bytes (256 RGBA colors), got ${colors.length}`);
    }
    this.device.queue.writeTexture(
      { texture: this.tempPaletteTexture },
      colors,
      { bytesPerRow: 256 * 4 },
      [256, 1]
    );
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

  /** Get pressure layer for external control */
  getPressureLayer(): PressureLayer {
    return this.pressureLayer;
  }

  /**
   * Initialize test pressure contour for visual debugging
   * Creates a simple latitude circle to verify render pipeline
   */
  private initTestPressureContour(): void {
    const EARTH_RADIUS = 1.02;  // 2% above globe surface for visibility
    const segments = 72;  // 5° per segment
    const vertices: number[] = [];

    // Create test circles at various latitudes (like isobars)
    const testLatitudes = [0, 30, -30, 60, -60];  // degrees

    for (const latDeg of testLatitudes) {
      const lat = latDeg * Math.PI / 180;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      const r = EARTH_RADIUS * cosLat;
      const y = EARTH_RADIUS * sinLat;

      for (let i = 0; i < segments; i++) {
        const lon0 = (i / segments) * Math.PI * 2;
        const lon1 = ((i + 1) / segments) * Math.PI * 2;

        // Line segment start
        vertices.push(r * Math.sin(lon0), y, r * Math.cos(lon0), 1.0);
        // Line segment end
        vertices.push(r * Math.sin(lon1), y, r * Math.cos(lon1), 1.0);
      }
    }

    // Upload test vertices and enable layer
    this.pressureLayer.setTestVertices(new Float32Array(vertices));
    this.pressureLayer.setEnabled(true);

    // Set initial uniforms (will be updated in render loop)
    const viewProj = new Float32Array(16);
    this.pressureLayer.updateUniforms({
      viewProj,
      eyePosition: [0, 0, 3],
      sunDirection: [1, 0, 0],
      opacity: 0.85,
    }, false);
  }

  dispose(): void {
    this.uniformBuffer?.destroy();
    this.basemapTexture?.destroy();
    this.gaussianLatsBuffer?.destroy();
    this.ringOffsetsBuffer?.destroy();
    this.tempDataBuffer?.destroy();
    this.rainDataBuffer?.destroy();
    this.fontAtlasTexture?.destroy();
    this.tempPaletteTexture?.destroy();
    this.depthTexture?.destroy();
    this.colorTexture?.destroy();
    this.pressureLayer?.dispose();
  }
}
