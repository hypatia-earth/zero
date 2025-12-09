/**
 * GlobeRenderer - WebGPU globe rendering
 */

import { Camera } from './camera';
import globeShaderCode from './shaders/globe.wgsl?raw';

export interface GlobeUniforms {
  viewProjInverse: Float32Array;
  eyePosition: Float32Array;
  resolution: Float32Array;
  time: number;
  sunEnabled: boolean;
  sunDirection: Float32Array;
  gridEnabled: boolean;
  gridOpacity: number;
  earthOpacity: number;
  tempOpacity: number;
  rainOpacity: number;
  tempDataReady: boolean;
  rainDataReady: boolean;
}

export class GlobeRenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private pipeline!: GPURenderPipeline;
  private uniformBuffer!: GPUBuffer;
  private bindGroup!: GPUBindGroup;
  private basemapTexture!: GPUTexture;
  private basemapSampler!: GPUSampler;
  private gaussianLatsBuffer!: GPUBuffer;
  private ringOffsetsBuffer!: GPUBuffer;
  private tempDataBuffer!: GPUBuffer;
  private rainDataBuffer!: GPUBuffer;

  readonly camera: Camera;
  private uniformData = new ArrayBuffer(256);
  private uniformView = new DataView(this.uniformData);

  constructor(private canvas: HTMLCanvasElement) {
    this.camera = new Camera({ lat: 30, lon: 0, distance: 3 });
  }

  async initialize(): Promise<void> {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter found');
    this.device = await adapter.requestDevice();

    this.context = this.canvas.getContext('webgpu')!;
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format, alphaMode: 'premultiplied' });

    this.uniformBuffer = this.device.createBuffer({
      size: 256,
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

    // Weather data (6.6M points)
    const dataSize = 6_599_680 * 4;
    this.tempDataBuffer = this.device.createBuffer({
      size: dataSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.rainDataBuffer = this.device.createBuffer({
      size: dataSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = this.device.createShaderModule({ code: globeShaderCode });

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

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
      ],
    });

    this.resize();
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

    // vec2 resolution + padding (16 bytes)
    view.setFloat32(offset, uniforms.resolution[0]!, true); offset += 4;
    view.setFloat32(offset, uniforms.resolution[1]!, true); offset += 4;
    offset += 8;

    // time, sunEnabled
    view.setFloat32(offset, uniforms.time, true); offset += 4;
    view.setUint32(offset, uniforms.sunEnabled ? 1 : 0, true); offset += 4;

    // vec3 sunDirection + padding (16 bytes)
    view.setFloat32(offset, uniforms.sunDirection[0]!, true); offset += 4;
    view.setFloat32(offset, uniforms.sunDirection[1]!, true); offset += 4;
    view.setFloat32(offset, uniforms.sunDirection[2]!, true); offset += 4;
    offset += 4;

    // gridEnabled, gridOpacity, earthOpacity, tempOpacity
    view.setUint32(offset, uniforms.gridEnabled ? 1 : 0, true); offset += 4;
    view.setFloat32(offset, uniforms.gridOpacity, true); offset += 4;
    view.setFloat32(offset, uniforms.earthOpacity, true); offset += 4;
    view.setFloat32(offset, uniforms.tempOpacity, true); offset += 4;

    // rainOpacity, tempDataReady, rainDataReady
    view.setFloat32(offset, uniforms.rainOpacity, true); offset += 4;
    view.setUint32(offset, uniforms.tempDataReady ? 1 : 0, true); offset += 4;
    view.setUint32(offset, uniforms.rainDataReady ? 1 : 0, true); offset += 4;

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
      ],
    });
  }

  uploadGaussianLUTs(lats: Float32Array, offsets: Uint32Array): void {
    this.device.queue.writeBuffer(this.gaussianLatsBuffer, 0, lats.buffer, lats.byteOffset, lats.byteLength);
    this.device.queue.writeBuffer(this.ringOffsetsBuffer, 0, offsets.buffer, offsets.byteOffset, offsets.byteLength);
  }

  uploadTempData(data: Float32Array, offset: number = 0): void {
    this.device.queue.writeBuffer(this.tempDataBuffer, offset, data.buffer, data.byteOffset, data.byteLength);
  }

  uploadRainData(data: Float32Array, offset: number = 0): void {
    this.device.queue.writeBuffer(this.rainDataBuffer, offset, data.buffer, data.byteOffset, data.byteLength);
  }

  dispose(): void {
    this.uniformBuffer?.destroy();
    this.basemapTexture?.destroy();
    this.gaussianLatsBuffer?.destroy();
    this.ringOffsetsBuffer?.destroy();
    this.tempDataBuffer?.destroy();
    this.rainDataBuffer?.destroy();
  }
}
