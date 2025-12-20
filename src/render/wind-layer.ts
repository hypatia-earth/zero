/**
 * WindLayer - GPU-based wind vector field rendering
 *
 * T2: Seed Points - Fibonacci sphere distribution visible as dots
 * Future phases will add:
 * - T3: Wind data upload and integration
 * - T4: Particle simulation and trails
 */

import windRenderCode from './shaders/wind-render.wgsl?raw';
import { generateFibonacciSphere } from '../utils/fibonacci-sphere';

interface WindUniforms {
  viewProj: Float32Array;
  eyePosition: [number, number, number];
  opacity: number;
}

export class WindLayer {
  private device: GPUDevice;
  private format: GPUTextureFormat;

  // Render pipeline
  private renderPipeline!: GPURenderPipeline;
  private renderUniformBuffer!: GPUBuffer;
  private renderBindGroup!: GPUBindGroup;
  private renderBindGroupLayout!: GPUBindGroupLayout;

  // Seed buffer (Fibonacci sphere positions)
  private seedBuffer!: GPUBuffer;
  private seedCount: number;

  // State
  private enabled = false;

  constructor(device: GPUDevice, format: GPUTextureFormat, lineCount = 8192) {
    this.device = device;
    this.format = format;
    this.seedCount = lineCount;

    this.createRenderPipeline();
    this.createRenderBuffers();
  }

  private createRenderPipeline(): void {
    // Render bind group layout (uniforms + seed buffer)
    this.renderBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    // Render pipeline for point primitives
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
        topology: 'point-list',
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less-equal',  // Depth test against globe
      },
    });
  }

  private createRenderBuffers(): void {
    // Render uniform buffer (viewProj + eyePos + opacity)
    this.renderUniformBuffer = this.device.createBuffer({
      size: 96,  // mat4 + vec3 + pad + f32 + pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Generate Fibonacci sphere seed positions
    const seedPositions = generateFibonacciSphere(this.seedCount);

    this.seedBuffer = this.device.createBuffer({
      size: seedPositions.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.seedBuffer, 0, seedPositions.buffer, seedPositions.byteOffset, seedPositions.byteLength);

    // Create bind group
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
        { binding: 1, resource: { buffer: this.seedBuffer } },
      ],
    });
  }

  /**
   * Update render uniforms
   */
  updateUniforms(uniforms: WindUniforms): void {
    const uniformData = new ArrayBuffer(96);
    const floatView = new Float32Array(uniformData);

    // viewProj (16 floats)
    floatView.set(uniforms.viewProj, 0);
    // eyePosition (3 floats + 1 pad)
    floatView.set(uniforms.eyePosition, 16);
    // opacity (1 float)
    floatView[20] = uniforms.opacity;

    this.device.queue.writeBuffer(this.renderUniformBuffer, 0, uniformData);
  }

  /**
   * Render wind layer (T2: Fibonacci sphere seed points)
   */
  render(renderPass: GPURenderPassEncoder): void {
    if (!this.enabled) return;

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.renderBindGroup);
    renderPass.draw(this.seedCount);  // Draw seed points
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Change line count (resizes seed buffer)
   * @param lineCount Number of seed points (8K, 16K, 32K)
   */
  setLineCount(lineCount: number): void {
    if (lineCount === this.seedCount) return;

    console.log(`[Wind] Changing line count: ${this.seedCount} → ${lineCount}`);
    this.seedCount = lineCount;

    // Destroy old seed buffer
    this.seedBuffer.destroy();

    // Generate new seed positions
    const seedPositions = generateFibonacciSphere(this.seedCount);

    // Create new seed buffer
    this.seedBuffer = this.device.createBuffer({
      size: seedPositions.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.seedBuffer, 0, seedPositions.buffer, seedPositions.byteOffset, seedPositions.byteLength);

    // Recreate bind group with new seed buffer
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
        { binding: 1, resource: { buffer: this.seedBuffer } },
      ],
    });
  }

  getLineCount(): number {
    return this.seedCount;
  }

  dispose(): void {
    this.renderUniformBuffer?.destroy();
    this.seedBuffer?.destroy();
  }
}
