/**
 * PressureLayer - GPU-based isobar contour rendering
 *
 * Phase 3: Skeleton with render pipeline structure
 * Phase 4: Full compute pipeline implementation
 *
 * Compute pipeline (Phase 4):
 * 1. Regrid: O1280 Gaussian → regular grid (1° or 2°)
 * 2. Count: Marching squares segment count per cell
 * 3. Prefix sum: Compute output offsets
 * 4. Generate: Create line segment vertices
 *
 * Render pipeline:
 * - Line-list primitives with depth testing against globe
 * - Day/night tinting, standard pressure highlight
 */

import contourRenderCode from './shaders/contour-render.wgsl?raw';

/** Isobar configuration from Hypatia */
export const ISOBAR_CONFIG = {
  levels: [960, 964, 968, 972, 976, 980, 984, 988, 992, 996,
           1000, 1004, 1008, 1012, 1016, 1020, 1024, 1028, 1032, 1036, 1040],
  spacing: 4,  // hPa between levels
  standard: 1012,  // Highlighted isobar (sea level pressure)
} as const;

/** Grid resolution options */
export type PressureResolution = 1 | 2;  // degrees

interface PressureUniforms {
  viewProj: Float32Array;
  eyePosition: [number, number, number];
  sunDirection: [number, number, number];
  opacity: number;
}

export class PressureLayer {
  private device: GPUDevice;
  private format: GPUTextureFormat;

  // Grid dimensions based on resolution
  private gridWidth: number;
  private gridHeight: number;

  // Render pipeline
  private renderPipeline!: GPURenderPipeline;
  private renderUniformBuffer!: GPUBuffer;
  private renderBindGroup!: GPUBindGroup;
  private renderBindGroupLayout!: GPUBindGroupLayout;

  // Placeholder vertex buffer (Phase 4 will generate real vertices)
  private vertexBuffer!: GPUBuffer;

  // State
  private enabled = false;
  private vertexCount = 0;

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    resolution: PressureResolution
  ) {
    this.device = device;
    this.format = format;

    // Set grid dimensions based on resolution
    this.gridWidth = 360 / resolution;   // 360 (1°) or 180 (2°)
    this.gridHeight = 180 / resolution;  // 180 (1°) or 90 (2°)

    this.createRenderPipeline();
    this.createBuffers();
  }

  private createRenderPipeline(): void {
    // Render bind group layout
    this.renderBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    // Render pipeline
    const renderModule = this.device.createShaderModule({ code: contourRenderCode });
    this.renderPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.renderBindGroupLayout] }),
      vertex: { module: renderModule, entryPoint: 'vertexMain' },
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
      primitive: { topology: 'line-list' },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less-equal',  // Allow slight overlap with globe
      },
    });
  }

  private createBuffers(): void {
    const maxSegments = (this.gridWidth - 1) * (this.gridHeight - 1) * 2;
    const maxVertices = maxSegments * 2;

    // Render uniform buffer (viewProj + eyePos + sunDir + opacity + isStandard)
    this.renderUniformBuffer = this.device.createBuffer({
      size: 128,  // mat4 + vec3 + pad + vec3 + f32 + u32 + vec3 pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Placeholder vertex buffer
    this.vertexBuffer = this.device.createBuffer({
      size: Math.max(maxVertices * 16, 64),  // vec4f per vertex, min 64 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Create bind group
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
        { binding: 1, resource: { buffer: this.vertexBuffer } },
      ],
    });
  }

  /**
   * Update render uniforms
   */
  updateUniforms(uniforms: PressureUniforms, isStandard: boolean): void {
    const uniformData = new ArrayBuffer(128);
    const floatView = new Float32Array(uniformData);
    const uintView = new Uint32Array(uniformData);

    // viewProj (16 floats)
    floatView.set(uniforms.viewProj, 0);
    // eyePosition (3 floats + 1 pad)
    floatView.set(uniforms.eyePosition, 16);
    // sunDirection (3 floats) + opacity (1 float)
    floatView.set(uniforms.sunDirection, 20);
    floatView[23] = uniforms.opacity;
    // isStandard (1 u32) + pad
    uintView[24] = isStandard ? 1 : 0;

    this.device.queue.writeBuffer(this.renderUniformBuffer, 0, uniformData);
  }

  /**
   * Set test vertices for visual debugging
   * Phase 4 will replace this with compute-generated vertices
   */
  setTestVertices(vertices: Float32Array): void {
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices.buffer);
    this.vertexCount = vertices.length / 4;  // vec4f per vertex
  }

  /**
   * Render contour lines
   */
  render(renderPass: GPURenderPassEncoder): void {
    if (this.vertexCount === 0 || !this.enabled) return;

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.renderBindGroup);
    renderPass.draw(this.vertexCount);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getVertexCount(): number {
    return this.vertexCount;
  }

  getGridDimensions(): { width: number; height: number } {
    return { width: this.gridWidth, height: this.gridHeight };
  }

  dispose(): void {
    this.renderUniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
  }
}
