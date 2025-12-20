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
import { defaultConfig } from '../config/defaults';

interface WindUniforms {
  viewProj: Float32Array;
  eyePosition: [number, number, number];
  opacity: number;
  animPhase: number;    // 0-1 animation phase
  snakeLength: number;  // fraction of line visible (0-1)
  lineWidth: number;    // screen-space width factor
  showBackface: number; // 1.0 when no texture layers visible (show full geometry)
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

  // Wind data buffers (O1280 hurricane test data - two timesteps)
  private windU0Buffer!: GPUBuffer;
  private windV0Buffer!: GPUBuffer;
  private windU1Buffer!: GPUBuffer;
  private windV1Buffer!: GPUBuffer;
  private gaussianLatsBuffer!: GPUBuffer;
  private ringOffsetsBuffer!: GPUBuffer;

  // Interpolation state
  private interpFactor = 0;

  // External buffer mode (don't destroy buffers - owned by LayerStore)
  private useExternalBuffers = false;

  // Line points buffer (compute output, render input)
  private linePointsBuffer!: GPUBuffer;
  private segmentsPerLine = defaultConfig.wind.segmentsPerLine;

  // State
  private enabled = false;
  private randomSeed = Math.random();

  // Compute caching: only recompute when time changes (minute precision)
  private lastComputedMinute = -1;  // Force initial compute
  private needsCompute = true;

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
    // Compute bind group layout: uniforms, seeds, windU0, windV0, windU1, windV1, gaussianLats, ringOffsets, linePoints
    this.computeBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
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

    // Generate hurricane test data (t0 and t1)
    const hurricaneData = generateHurricaneTestData();
    console.log(`[Wind] Hurricane data: ${hurricaneData.t0.u.length} points × 2 timesteps`);

    // Create wind U/V buffers for t0
    this.windU0Buffer = this.device.createBuffer({
      size: hurricaneData.t0.u.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.windU0Buffer, 0, hurricaneData.t0.u.buffer, hurricaneData.t0.u.byteOffset, hurricaneData.t0.u.byteLength);

    this.windV0Buffer = this.device.createBuffer({
      size: hurricaneData.t0.v.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.windV0Buffer, 0, hurricaneData.t0.v.buffer, hurricaneData.t0.v.byteOffset, hurricaneData.t0.v.byteLength);

    // Create wind U/V buffers for t1
    this.windU1Buffer = this.device.createBuffer({
      size: hurricaneData.t1.u.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.windU1Buffer, 0, hurricaneData.t1.u.buffer, hurricaneData.t1.u.byteOffset, hurricaneData.t1.u.byteLength);

    this.windV1Buffer = this.device.createBuffer({
      size: hurricaneData.t1.v.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.windV1Buffer, 0, hurricaneData.t1.v.buffer, hurricaneData.t1.v.byteOffset, hurricaneData.t1.v.byteLength);

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
    this.updateComputeUniforms(defaultConfig.wind.stepFactor);

    // Create compute bind group
    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: { buffer: this.seedBuffer } },
        { binding: 2, resource: { buffer: this.windU0Buffer } },
        { binding: 3, resource: { buffer: this.windV0Buffer } },
        { binding: 4, resource: { buffer: this.windU1Buffer } },
        { binding: 5, resource: { buffer: this.windV1Buffer } },
        { binding: 6, resource: { buffer: this.gaussianLatsBuffer } },
        { binding: 7, resource: { buffer: this.ringOffsetsBuffer } },
        { binding: 8, resource: { buffer: this.linePointsBuffer } },
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
        topology: 'triangle-list',
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: false,
        depthCompare: 'less-equal',
      },
    });
  }

  private createRenderBuffers(): void {
    // Render uniform buffer (viewProj + eyePos + opacity + animPhase + snakeLength + lineWidth + randomSeed + showBackface)
    // mat4(64) + vec3(12) + f32(4) + f32×5(20) + pad(12) = 112 bytes
    this.renderUniformBuffer = this.device.createBuffer({
      size: 112,
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
    // interpFactor (f32)
    floatView[3] = this.interpFactor;

    this.device.queue.writeBuffer(this.computeUniformBuffer, 0, uniformData);
  }

  // Pending minute for next compute (set by setInterpFactor, used by runCompute)
  private pendingMinute = -1;

  /**
   * Set interpolation factor and current time
   * Recomputes when time changes by at least 1 minute
   */
  setInterpFactor(factor: number, time?: Date): void {
    this.interpFactor = Math.max(0, Math.min(1, factor));

    // Compare minute-precision timestamps to trigger recompute
    if (time) {
      const currentMinute = Math.floor(time.getTime() / 60000);
      if (currentMinute !== this.lastComputedMinute) {
        this.needsCompute = true;
        this.pendingMinute = currentMinute;
      }
    }
  }

  getInterpFactor(): number {
    return this.interpFactor;
  }

  /**
   * Set external buffers from LayerStore (live data mode)
   * Replaces test data buffers and recreates compute bind group
   */
  setExternalBuffers(
    u0: GPUBuffer, v0: GPUBuffer,
    u1: GPUBuffer, v1: GPUBuffer,
    gaussianLats: GPUBuffer, ringOffsets: GPUBuffer
  ): void {
    // Store references (don't destroy - owned by LayerStore)
    this.windU0Buffer = u0;
    this.windV0Buffer = v0;
    this.windU1Buffer = u1;
    this.windV1Buffer = v1;
    this.gaussianLatsBuffer = gaussianLats;
    this.ringOffsetsBuffer = ringOffsets;

    // Mark as using external buffers (don't destroy in dispose)
    this.useExternalBuffers = true;
    this.needsCompute = true;  // Force recompute with new data

    // Recreate compute bind group with new buffers
    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: { buffer: this.seedBuffer } },
        { binding: 2, resource: { buffer: this.windU0Buffer } },
        { binding: 3, resource: { buffer: this.windV0Buffer } },
        { binding: 4, resource: { buffer: this.windU1Buffer } },
        { binding: 5, resource: { buffer: this.windV1Buffer } },
        { binding: 6, resource: { buffer: this.gaussianLatsBuffer } },
        { binding: 7, resource: { buffer: this.ringOffsetsBuffer } },
        { binding: 8, resource: { buffer: this.linePointsBuffer } },
      ],
    });

    console.log('[Wind] External buffers set (live data mode)');
  }

  /**
   * Update render uniforms
   */
  updateUniforms(uniforms: WindUniforms): void {
    const uniformData = new ArrayBuffer(112);  // 28 floats (96 + 16 for alignment)
    const floatView = new Float32Array(uniformData);

    // viewProj (16 floats)
    floatView.set(uniforms.viewProj, 0);
    // eyePosition (3 floats)
    floatView.set(uniforms.eyePosition, 16);
    // opacity (1 float) - packs with eyePosition as vec4
    floatView[19] = uniforms.opacity;
    // animPhase (1 float)
    floatView[20] = uniforms.animPhase;
    // snakeLength (1 float)
    floatView[21] = uniforms.snakeLength;
    // lineWidth (1 float)
    floatView[22] = uniforms.lineWidth;
    // randomSeed (1 float)
    floatView[23] = this.randomSeed;
    // showBackface (1 float)
    floatView[24] = uniforms.showBackface;

    this.device.queue.writeBuffer(this.renderUniformBuffer, 0, uniformData);
  }

  /**
   * Run compute pass to trace wind lines (only if needed)
   * Returns true if compute was actually run
   */
  runCompute(commandEncoder: GPUCommandEncoder): boolean {
    // Skip if no recompute needed (interpolation unchanged)
    if (!this.needsCompute) {
      return false;
    }

    // Update uniforms with current interpolation factor
    this.updateComputeUniforms(defaultConfig.wind.stepFactor);

    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);

    // Dispatch: one thread per line, workgroup size is 64
    const workgroups = Math.ceil(this.seedCount / 64);
    computePass.dispatchWorkgroups(workgroups);
    computePass.end();

    // Mark as computed
    this.lastComputedMinute = this.pendingMinute;
    this.needsCompute = false;
    return true;
  }

  /**
   * Render wind layer (T3: Wind lines traced on sphere surface)
   */
  render(renderPass: GPURenderPassEncoder): void {
    if (!this.enabled) return;

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.renderBindGroup);

    // Triangle-list: (segments-1) × 6 vertices per instance for 31 quad segments
    // 32 points → 31 segments → 186 vertices per instance (6 per quad)
    const verticesPerInstance = (this.segmentsPerLine - 1) * 6;
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
    this.randomSeed = Math.random();  // Scramble phase offsets
    this.needsCompute = true;  // Force recompute with new line count

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
    this.updateComputeUniforms(defaultConfig.wind.stepFactor);

    // Recreate compute bind group
    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: { buffer: this.seedBuffer } },
        { binding: 2, resource: { buffer: this.windU0Buffer } },
        { binding: 3, resource: { buffer: this.windV0Buffer } },
        { binding: 4, resource: { buffer: this.windU1Buffer } },
        { binding: 5, resource: { buffer: this.windV1Buffer } },
        { binding: 6, resource: { buffer: this.gaussianLatsBuffer } },
        { binding: 7, resource: { buffer: this.ringOffsetsBuffer } },
        { binding: 8, resource: { buffer: this.linePointsBuffer } },
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
    this.linePointsBuffer?.destroy();

    // Only destroy wind buffers if we own them (not in external buffer mode)
    if (!this.useExternalBuffers) {
      this.windU0Buffer?.destroy();
      this.windV0Buffer?.destroy();
      this.windU1Buffer?.destroy();
      this.windV1Buffer?.destroy();
      this.gaussianLatsBuffer?.destroy();
      this.ringOffsetsBuffer?.destroy();
    }
  }
}
