/**
 * WindLayer - GPU-based wind vector field rendering
 *
 * T1: Minimal scaffolding - renders white quad to verify toggle/opacity
 * Future phases will add:
 * - T2: Compute pipeline for particle simulation
 * - T3: Wind data upload and integration
 * - T4: Particle rendering with trails
 */

import windRenderCode from './shaders/wind-render.wgsl?raw';

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

  // Vertex buffer (simple quad for now)
  private vertexBuffer!: GPUBuffer;

  // State
  private enabled = false;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;

    this.createRenderPipeline();
    this.createRenderBuffers();
  }

  private createRenderPipeline(): void {
    // Render bind group layout (uniforms only for T1)
    this.renderBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    // Render pipeline
    const renderModule = this.device.createShaderModule({ code: windRenderCode });
    this.renderPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.renderBindGroupLayout] }),
      vertex: {
        module: renderModule,
        entryPoint: 'vertexMain',
        buffers: [{
          arrayStride: 8,  // 2 floats per vertex
          attributes: [{
            shaderLocation: 0,
            offset: 0,
            format: 'float32x2',
          }],
        }],
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
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: false,  // Don't write depth for particles
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

    // Simple fullscreen quad vertices (2 triangles)
    // Positions in normalized device coordinates (NDC)
    const quadVertices = new Float32Array([
      // Triangle 1
      -1, -1,
       1, -1,
       1,  1,
      // Triangle 2
      -1, -1,
       1,  1,
      -1,  1,
    ]);

    this.vertexBuffer = this.device.createBuffer({
      size: quadVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, quadVertices);

    // Create bind group
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
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
   * Render wind layer (T1: simple white quad)
   */
  render(renderPass: GPURenderPassEncoder): void {
    if (!this.enabled) return;

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.renderBindGroup);
    renderPass.setVertexBuffer(0, this.vertexBuffer);
    renderPass.draw(6);  // 2 triangles = 6 vertices
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  dispose(): void {
    this.renderUniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
  }
}
