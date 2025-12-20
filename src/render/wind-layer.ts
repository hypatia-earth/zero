/**
 * WindLayer - GPU-based wind vector field rendering
 *
 * T4: Hurricane Projection - Wind lines sample O1280 hurricane test data
 * - Compute shader traces wind lines with on-sphere geodesic movement
 * - Samples synthetic hurricane data from O1280 grid
 * - Render shader displays line segments following wind field
 */

import windRenderCode from './shaders/wind-render.wgsl?raw';
import windComputeCode from './shaders/wind-compute.wgsl?raw';
import { generateFibonacciSphere } from '../utils/fibonacci-sphere';
import { generateHurricaneTestData } from '../../tests/wind-test-data';
import { generateGaussianLUTs } from './gaussian-grid';

interface WindUniforms {
  viewProj: Float32Array;
  eyePosition: [number, number, number];
  opacity: number;
}

export class WindLayer {
  private device: GPUDevice;
  private format: GPUTextureFormat;

  // Compute pipeline
  private computePipeline!: GPUComputePipeline;
  private computeUniformBuffer!: GPUBuffer;
  private computeBindGroup!: GPUBindGroup;
  private computeBindGroupLayout!: GPUBindGroupLayout;

  // Render pipeline
  private renderPipeline!: GPURenderPipeline;
  private renderUniformBuffer!: GPUBuffer;
  private renderBindGroup!: GPUBindGroup;
  private renderBindGroupLayout!: GPUBindGroupLayout;

  // Seed buffer (Fibonacci sphere positions)
  private seedBuffer!: GPUBuffer;
  private seedCount: number;

  // Wind data buffers (O1280 hurricane test data)
  private windUBuffer!: GPUBuffer;
  private windVBuffer!: GPUBuffer;
  private gaussianLatsBuffer!: GPUBuffer;
  private ringOffsetsBuffer!: GPUBuffer;

  // Line points buffer (compute output, render input)
  private linePointsBuffer!: GPUBuffer;
  private segmentsPerLine = 32;

  // State
  private enabled = false;

  constructor(device: GPUDevice, format: GPUTextureFormat, lineCount = 8192) {
    this.device = device;
    this.format = format;
    this.seedCount = lineCount;

    this.createComputePipeline();
    this.createComputeBuffers();
    this.createRenderPipeline();
    this.createRenderBuffers();
  }

  private createComputePipeline(): void {
    // Compute bind group layout (uniforms + seeds + windU + windV + gaussianLats + ringOffsets + linePoints)
    this.computeBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    // Compute pipeline for wind line tracing
    const computeModule = this.device.createShaderModule({ code: windComputeCode });
    this.computePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.computeBindGroupLayout] }),
      compute: {
        module: computeModule,
        entryPoint: 'computeMain',
      },
    });
  }

  private createComputeBuffers(): void {
    // Compute uniform buffer (lineCount, segments, stepFactor, _pad)
    // u32 + u32 + f32 + u32 = 16 bytes
    this.computeUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Line points buffer: lineCount × segments × (vec3 + f32) = 8192 × 32 × 16 = 4 MB
    const linePointsSize = this.seedCount * this.segmentsPerLine * 16;
    this.linePointsBuffer = this.device.createBuffer({
      size: linePointsSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });

    // Generate Fibonacci sphere seed positions
    const seedPositions = generateFibonacciSphere(this.seedCount);
    this.seedBuffer = this.device.createBuffer({
      size: seedPositions.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.seedBuffer, 0, seedPositions.buffer, seedPositions.byteOffset, seedPositions.byteLength);

    // Generate hurricane test data (t0)
    const hurricaneData = generateHurricaneTestData();
    console.log(`[Wind] Hurricane data: ${hurricaneData.t0.u.length} points`);

    // Create wind U/V buffers
    this.windUBuffer = this.device.createBuffer({
      size: hurricaneData.t0.u.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.windUBuffer, 0, hurricaneData.t0.u.buffer, hurricaneData.t0.u.byteOffset, hurricaneData.t0.u.byteLength);

    this.windVBuffer = this.device.createBuffer({
      size: hurricaneData.t0.v.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.windVBuffer, 0, hurricaneData.t0.v.buffer, hurricaneData.t0.v.byteOffset, hurricaneData.t0.v.byteLength);

    // Generate Gaussian grid LUTs
    const luts = generateGaussianLUTs(1280);
    console.log(`[Wind] Gaussian LUTs: ${luts.lats.length} rings, ${luts.totalPoints} points`);

    // Create Gaussian grid buffers
    this.gaussianLatsBuffer = this.device.createBuffer({
      size: luts.lats.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.gaussianLatsBuffer, 0, luts.lats.buffer, luts.lats.byteOffset, luts.lats.byteLength);

    this.ringOffsetsBuffer = this.device.createBuffer({
      size: luts.offsets.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.ringOffsetsBuffer, 0, luts.offsets.buffer, luts.offsets.byteOffset, luts.offsets.byteLength);

    // Initialize compute uniforms (smaller stepFactor = smoother lines)
    this.updateComputeUniforms(0.005);

    // Create compute bind group
    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: { buffer: this.seedBuffer } },
        { binding: 2, resource: { buffer: this.windUBuffer } },
        { binding: 3, resource: { buffer: this.windVBuffer } },
        { binding: 4, resource: { buffer: this.gaussianLatsBuffer } },
        { binding: 5, resource: { buffer: this.ringOffsetsBuffer } },
        { binding: 6, resource: { buffer: this.linePointsBuffer } },
      ],
    });
  }

  private createRenderPipeline(): void {
    // Render bind group layout (uniforms + linePoints buffer)
    this.renderBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    // Render pipeline for line-list primitives
    const renderModule = this.device.createShaderModule({ code: windRenderCode });
    this.renderPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.renderBindGroupLayout] }),
      vertex: {
        module: renderModule,
        entryPoint: 'vertexMain',
      },
      fragment: {
        module: renderModule,
        entryPoint: 'fragmentMain',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: {
        topology: 'line-list',
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: false,
        depthCompare: 'less-equal',
      },
    });
  }

  private createRenderBuffers(): void {
    // Render uniform buffer (viewProj + eyePos + opacity)
    this.renderUniformBuffer = this.device.createBuffer({
      size: 96,  // mat4 + vec3 + pad + f32 + pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group (uses linePoints buffer from compute)
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
        { binding: 1, resource: { buffer: this.linePointsBuffer } },
      ],
    });
  }

  /**
   * Update compute uniforms
   */
  private updateComputeUniforms(stepFactor: number): void {
    const uniformData = new ArrayBuffer(16);
    const uintView = new Uint32Array(uniformData);
    const floatView = new Float32Array(uniformData);

    // lineCount (u32)
    uintView[0] = this.seedCount;
    // segments (u32)
    uintView[1] = this.segmentsPerLine;
    // stepFactor (f32)
    floatView[2] = stepFactor;
    // _pad (u32)
    uintView[3] = 0;

    this.device.queue.writeBuffer(this.computeUniformBuffer, 0, uniformData);
  }

  /**
   * Update render uniforms
   */
  updateUniforms(uniforms: WindUniforms): void {
    const uniformData = new ArrayBuffer(96);
    const floatView = new Float32Array(uniformData);

    // viewProj (16 floats)
    floatView.set(uniforms.viewProj, 0);
    // eyePosition (3 floats)
    floatView.set(uniforms.eyePosition, 16);
    // opacity (1 float) - packs with eyePosition as vec4
    floatView[19] = uniforms.opacity;

    this.device.queue.writeBuffer(this.renderUniformBuffer, 0, uniformData);
  }

  /**
   * Run compute pass to trace wind lines
   */
  runCompute(commandEncoder: GPUCommandEncoder): void {
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);

    // Dispatch: one thread per line, workgroup size is 64
    const workgroups = Math.ceil(this.seedCount / 64);
    computePass.dispatchWorkgroups(workgroups);
    computePass.end();
  }

  /**
   * Render wind layer (T3: Wind lines traced on sphere surface)
   */
  render(renderPass: GPURenderPassEncoder): void {
    if (!this.enabled) return;

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.renderBindGroup);

    // Line-list: (segments-1) × 2 vertices per instance for 31 line segments
    // 32 points → 31 segments → 62 vertices per instance
    const verticesPerInstance = (this.segmentsPerLine - 1) * 2;
    renderPass.draw(verticesPerInstance, this.seedCount, 0, 0);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Change line count (resizes buffers)
   * @param lineCount Number of seed points (8K, 16K, 32K)
   */
  setLineCount(lineCount: number): void {
    if (lineCount === this.seedCount) return;

    console.log(`[Wind] Changing line count: ${this.seedCount} → ${lineCount}`);
    this.seedCount = lineCount;

    // Destroy old buffers
    this.seedBuffer.destroy();
    this.linePointsBuffer.destroy();

    // Generate new seed positions
    const seedPositions = generateFibonacciSphere(this.seedCount);

    // Create new seed buffer
    this.seedBuffer = this.device.createBuffer({
      size: seedPositions.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.seedBuffer, 0, seedPositions.buffer, seedPositions.byteOffset, seedPositions.byteLength);

    // Create new line points buffer
    const linePointsSize = this.seedCount * this.segmentsPerLine * 16;
    this.linePointsBuffer = this.device.createBuffer({
      size: linePointsSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });

    // Update compute uniforms with new line count
    this.updateComputeUniforms(0.005);

    // Recreate compute bind group
    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: { buffer: this.seedBuffer } },
        { binding: 2, resource: { buffer: this.windUBuffer } },
        { binding: 3, resource: { buffer: this.windVBuffer } },
        { binding: 4, resource: { buffer: this.gaussianLatsBuffer } },
        { binding: 5, resource: { buffer: this.ringOffsetsBuffer } },
        { binding: 6, resource: { buffer: this.linePointsBuffer } },
      ],
    });

    // Recreate render bind group
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
        { binding: 1, resource: { buffer: this.linePointsBuffer } },
      ],
    });
  }

  getLineCount(): number {
    return this.seedCount;
  }

  dispose(): void {
    this.computeUniformBuffer?.destroy();
    this.renderUniformBuffer?.destroy();
    this.seedBuffer?.destroy();
    this.windUBuffer?.destroy();
    this.windVBuffer?.destroy();
    this.gaussianLatsBuffer?.destroy();
    this.ringOffsetsBuffer?.destroy();
    this.linePointsBuffer?.destroy();
  }
}
