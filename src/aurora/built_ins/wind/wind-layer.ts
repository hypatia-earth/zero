/**
 * WindLayer — built-in AuroraLayer for animated wind particle field.
 *
 * Compute shader traces wind lines with on-sphere geodesic movement, sampling
 * Gaussian-grid u/v components. Render shader displays line segments as quads
 * with palette colouring. Unlike graticule/cities (composed via blendXxx in
 * main.wesl), wind has its own GPU compute pass and its own render pass — all
 * three AuroraLayer methods get real bodies.
 *
 * Per-frame cross-layer values (animated opacity, layer state with lerp,
 * cross-layer-derived showBackface for backface culling) flow through a
 * narrow host handle. animSpeed currently flows through the host too pending
 * Sub-B's typed-setters phase.
 */

import windRenderCode from './render.wesl?static';
import windComputeCode from './compute.wesl?static';
import { generateFibonacciSphere } from '../../utils/fibonacci-sphere';
import { generateGaussianLUTs } from '../../utils/gaussian-grid';
import type {
  AuroraDataEvent,
  AuroraLayer,
  AuroraLayerContext,
  AuroraLayerFrame,
} from '../../types/aurora-layer';
import type { LayerState } from '../../types/layer-state';
import type { PaletteTexture } from '../../palette-texture';

// ── Config ────────────────────────────────────────────────────────────────

export interface WindAuroraLayerConfig {
  snakeLength: number;
  lineWidth: number;
  segmentsPerLine: number;
  stepFactor: number;
  radius: number;
}

export const WIND_DEFAULT_CONFIG: WindAuroraLayerConfig = {
  snakeLength: 0.25,
  lineWidth: 0.002,
  segmentsPerLine: 30,
  stepFactor: 0.005,
  radius: 1.0,
};

/**
 * Host-supplied per-frame values that wind needs but cannot derive locally:
 * - opacity is animated by the host's per-frame opacity-decay system
 * - layerState (mode, lerp, time) is built by the host worker from layer-slot state
 * - animSpeed is sourced from `wind.speed` option (host-owned options state)
 * - showBackface is a cross-layer occlusion-culling hint derived from EARTH/TEMP
 *   opacities; passing it lets wind skip back-hemisphere particles when those
 *   layers are opaque. Pure performance optimization.
 */
export interface WindAuroraLayerHost {
  getOpacity(): number;
  getLayerState(): LayerState;
  getAnimSpeed(): number;
  getShowBackface(): number;
}

// ── Internal types ────────────────────────────────────────────────────────

interface WindUniforms {
  viewProj: Float32Array;
  eyePosition: [number, number, number];
  opacity: number;
  animPhase: number;    // 0-1 animation phase
  snakeLength: number;  // fraction of line visible (0-1)
  lineWidth: number;    // screen-space width factor
  showBackface: number; // 1.0 when no texture layers visible (show full geometry)
  radius: number;       // sphere radius for wind particles (earth = 1.0)
  paletteIndex: number; // row index in palette texture array
  paletteCount: number; // total palettes in texture
}

const DEBUG = false;
const PALETTE_NAME = 'wind-speed';
const U_PARAM = 'wind_u_component_10m';
const V_PARAM = 'wind_v_component_10m';

// ── Layer ──────────────────────────────────────────────────────────────────

export class WindLayer implements AuroraLayer {
  readonly id = 'wind';
  readonly order = 20;

  private device!: GPUDevice;
  private format!: GPUTextureFormat;
  private paletteTexture!: PaletteTexture;
  private paletteIndex = 0;
  private paletteCount = 0;

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

  // Wind data buffers (Gaussian-grid u/v, two timesteps)
  private windU0Buffer!: GPUBuffer;
  private windV0Buffer!: GPUBuffer;
  private windU1Buffer!: GPUBuffer;
  private windV1Buffer!: GPUBuffer;
  private gaussianGridBuffer!: GPUBuffer;  // packed lats + offsets

  // Cached u/v buffers between onDataChanged events; setExternalBuffers needs all 4 at once.
  private cachedUBuffer0: GPUBuffer | null = null;
  private cachedUBuffer1: GPUBuffer | null = null;
  private cachedVBuffer0: GPUBuffer | null = null;
  private cachedVBuffer1: GPUBuffer | null = null;

  // Interpolation state
  private interpFactor = 0;

  // External buffer mode (don't destroy buffers - owned by LayerStore)
  private useExternalBuffers = false;

  // Line points buffer (compute output, render input)
  private linePointsBuffer!: GPUBuffer;
  private readonly segmentsPerLine = WIND_DEFAULT_CONFIG.segmentsPerLine;
  private readonly stepFactor = WIND_DEFAULT_CONFIG.stepFactor;
  private readonly snakeLength = WIND_DEFAULT_CONFIG.snakeLength;
  private readonly lineWidth = WIND_DEFAULT_CONFIG.lineWidth;
  private readonly radius = WIND_DEFAULT_CONFIG.radius;

  // Animation state
  private animPhase = 0;

  // State
  private enabled = false;
  private readonly randomSeed = 0;  // Fixed for deterministic rendering

  // Compute caching: only recompute when state changes
  private lastState: LayerState | null = null;
  private needsCompute = true;

  constructor(
    lineCount: number,
    private readonly host: WindAuroraLayerHost,
  ) {
    this.seedCount = lineCount;
  }

  initialize(ctx: AuroraLayerContext): void {
    this.device = ctx.device;
    this.format = ctx.format;
    this.paletteTexture = ctx.paletteTexture;

    this.createComputePipeline();
    this.createComputeBuffers();
    this.createRenderPipeline();
    this.createRenderBuffers();

    this.paletteIndex = ctx.paletteTexture.getPaletteIndex(PALETTE_NAME);
    this.paletteCount = ctx.paletteTexture.paletteCount;
  }

  onDataChanged(ctx: AuroraLayerContext, events: AuroraDataEvent[]): void {
    for (const ev of events) {
      if (ev.param === U_PARAM) {
        this.cachedUBuffer0 = ev.buffer0;
        this.cachedUBuffer1 = ev.buffer1;
      } else if (ev.param === V_PARAM) {
        this.cachedVBuffer0 = ev.buffer0;
        this.cachedVBuffer1 = ev.buffer1;
      }
    }
    if (this.cachedUBuffer0 && this.cachedUBuffer1 && this.cachedVBuffer0 && this.cachedVBuffer1) {
      this.setExternalBuffers(
        this.cachedUBuffer0, this.cachedVBuffer0,
        this.cachedUBuffer1, this.cachedVBuffer1,
        ctx.gaussianGridBuffer,
      );
    }
  }

  onOptionsChanged(_ctx: AuroraLayerContext, options: Record<string, unknown>): void {
    if ('seedCount' in options && typeof options.seedCount === 'number') {
      this.setLineCount(options.seedCount);
    }
  }

  compute(frame: AuroraLayerFrame): boolean {
    if (!this.enabled) return false;
    if (!this.needsCompute) return false;

    this.updateComputeUniforms(this.stepFactor);

    const computePass = frame.commandEncoder.beginComputePass();
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);

    // Dispatch: one thread per line, workgroup size is 64
    const workgroups = Math.ceil(this.seedCount / 64);
    computePass.dispatchWorkgroups(workgroups);
    computePass.end();

    this.needsCompute = false;
    return true;
  }

  update(frame: AuroraLayerFrame): void {
    const opacity = this.host.getOpacity();
    const state = this.host.getLayerState();
    const active = opacity > 0.01 && state.mode === 'pair';
    this.enabled = active;
    if (!active) return;

    this.advanceAnimation(frame.frameDeltaMs, this.host.getAnimSpeed());
    this.setState(state);

    this.updateUniforms({
      viewProj: frame.viewProj,
      eyePosition: [
        frame.eyePosition[0]!,
        frame.eyePosition[1]!,
        frame.eyePosition[2]!,
      ],
      opacity,
      animPhase: this.animPhase,
      snakeLength: this.snakeLength,
      lineWidth: this.lineWidth,
      showBackface: this.host.getShowBackface(),
      radius: this.radius,
      paletteIndex: this.paletteIndex,
      paletteCount: this.paletteCount,
    });
  }

  render(_frame: AuroraLayerFrame, renderPass: GPURenderPassEncoder): void {
    if (!this.enabled) return;

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.renderBindGroup);

    // Triangle-list: (segments-1) × 6 vertices per instance
    const verticesPerInstance = (this.segmentsPerLine - 1) * 6;
    renderPass.draw(verticesPerInstance, this.seedCount, 0, 0);
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
      this.gaussianGridBuffer?.destroy();
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private createComputePipeline(): void {
    // Compute bind group layout: uniforms, seeds, windU0, windV0, windU1, windV1, gaussianGrid, linePoints
    this.computeBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

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
    // Compute uniform buffer (lineCount, segments, stepFactor, interpFactor) = 16 bytes
    this.computeUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Line points buffer: lineCount × segments × (vec3 + f32)
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

    // Placeholder wind buffers (replaced by setExternalBuffers with real data)
    const placeholderSize = 4;
    this.windU0Buffer = this.device.createBuffer({
      size: placeholderSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.windV0Buffer = this.device.createBuffer({
      size: placeholderSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.windU1Buffer = this.device.createBuffer({
      size: placeholderSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.windV1Buffer = this.device.createBuffer({
      size: placeholderSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Generate Gaussian grid LUTs
    const luts = generateGaussianLUTs(1280);

    // Packed Gaussian grid buffer (interleaved lats + offsets as vec2<u32>)
    const interleaved = new Uint32Array(luts.lats.length * 2);
    const latBits = new Uint32Array(luts.lats.buffer, luts.lats.byteOffset, luts.lats.length);
    for (let i = 0; i < luts.lats.length; i++) {
      interleaved[i * 2] = latBits[i]!;
      interleaved[i * 2 + 1] = luts.offsets[i]!;
    }
    this.gaussianGridBuffer = this.device.createBuffer({
      size: interleaved.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.gaussianGridBuffer, 0, interleaved);

    this.updateComputeUniforms(this.stepFactor);

    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: { buffer: this.seedBuffer } },
        { binding: 2, resource: { buffer: this.windU0Buffer } },
        { binding: 3, resource: { buffer: this.windV0Buffer } },
        { binding: 4, resource: { buffer: this.windU1Buffer } },
        { binding: 5, resource: { buffer: this.windV1Buffer } },
        { binding: 6, resource: { buffer: this.gaussianGridBuffer } },
        { binding: 7, resource: { buffer: this.linePointsBuffer } },
      ],
    });
  }

  private createRenderPipeline(): void {
    this.renderBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

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
    // mat4(64) + vec3+f32(16) + f32×6(24) + u32×2(8) = 112 bytes
    this.renderUniformBuffer = this.device.createBuffer({
      size: 112,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
        { binding: 1, resource: { buffer: this.linePointsBuffer } },
        { binding: 2, resource: this.paletteTexture.texture.createView() },
        { binding: 3, resource: this.paletteTexture.sampler },
      ],
    });
  }

  private updateComputeUniforms(stepFactor: number): void {
    const uniformData = new ArrayBuffer(16);
    const uintView = new Uint32Array(uniformData);
    const floatView = new Float32Array(uniformData);

    uintView[0] = this.seedCount;
    uintView[1] = this.segmentsPerLine;
    floatView[2] = stepFactor;
    floatView[3] = this.interpFactor;

    this.device.queue.writeBuffer(this.computeUniformBuffer, 0, uniformData);
  }

  /**
   * Set layer state — triggers compute when state changes significantly
   */
  private setState(state: LayerState): void {
    this.interpFactor = state.mode === 'pair' ? state.lerp : 0;

    const needsRecompute = !this.lastState
      || state.mode !== this.lastState.mode
      || Math.floor(state.time.getTime() / 60000) !== Math.floor(this.lastState.time.getTime() / 60000);

    if (needsRecompute) {
      this.needsCompute = true;
      this.lastState = state;
    }
  }

  /**
   * Advance snake animation phase
   */
  private advanceAnimation(dtMs: number, animSpeed: number): void {
    const cyclesPerSec = animSpeed / this.segmentsPerLine;
    const dt = dtMs / 1000;
    this.animPhase = (this.animPhase + dt * cyclesPerSec) % 1;
  }

  /**
   * Set external buffers from LayerStore (live data mode)
   */
  private setExternalBuffers(
    u0: GPUBuffer, v0: GPUBuffer,
    u1: GPUBuffer, v1: GPUBuffer,
    gaussianGrid: GPUBuffer
  ): void {
    this.windU0Buffer = u0;
    this.windV0Buffer = v0;
    this.windU1Buffer = u1;
    this.windV1Buffer = v1;
    this.gaussianGridBuffer = gaussianGrid;

    this.useExternalBuffers = true;
    this.needsCompute = true;

    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: { buffer: this.seedBuffer } },
        { binding: 2, resource: { buffer: this.windU0Buffer } },
        { binding: 3, resource: { buffer: this.windV0Buffer } },
        { binding: 4, resource: { buffer: this.windU1Buffer } },
        { binding: 5, resource: { buffer: this.windV1Buffer } },
        { binding: 6, resource: { buffer: this.gaussianGridBuffer } },
        { binding: 7, resource: { buffer: this.linePointsBuffer } },
      ],
    });

    DEBUG && console.log('[Wind] External buffers set (live data mode)');
  }

  private updateUniforms(uniforms: WindUniforms): void {
    const uniformData = new ArrayBuffer(112);
    const floatView = new Float32Array(uniformData);
    const uintView = new Uint32Array(uniformData);

    floatView.set(uniforms.viewProj, 0);
    floatView.set(uniforms.eyePosition, 16);
    floatView[19] = uniforms.opacity;
    floatView[20] = uniforms.animPhase;
    floatView[21] = uniforms.snakeLength;
    floatView[22] = uniforms.lineWidth;
    floatView[23] = this.randomSeed;
    floatView[24] = uniforms.showBackface;
    floatView[25] = uniforms.radius;
    uintView[26] = uniforms.paletteIndex;
    uintView[27] = uniforms.paletteCount;

    this.device.queue.writeBuffer(this.renderUniformBuffer, 0, uniformData);
  }

  /**
   * Change line count (resizes buffers)
   */
  private setLineCount(lineCount: number): void {
    if (lineCount === this.seedCount) return;

    DEBUG && console.log(`[Wind] Changing line count: ${this.seedCount} → ${lineCount}`);
    this.seedCount = lineCount;
    this.needsCompute = true;

    this.seedBuffer.destroy();
    this.linePointsBuffer.destroy();

    const seedPositions = generateFibonacciSphere(this.seedCount);

    this.seedBuffer = this.device.createBuffer({
      size: seedPositions.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.seedBuffer, 0, seedPositions.buffer, seedPositions.byteOffset, seedPositions.byteLength);

    const linePointsSize = this.seedCount * this.segmentsPerLine * 16;
    this.linePointsBuffer = this.device.createBuffer({
      size: linePointsSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });

    this.updateComputeUniforms(this.stepFactor);

    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: { buffer: this.seedBuffer } },
        { binding: 2, resource: { buffer: this.windU0Buffer } },
        { binding: 3, resource: { buffer: this.windV0Buffer } },
        { binding: 4, resource: { buffer: this.windU1Buffer } },
        { binding: 5, resource: { buffer: this.windV1Buffer } },
        { binding: 6, resource: { buffer: this.gaussianGridBuffer } },
        { binding: 7, resource: { buffer: this.linePointsBuffer } },
      ],
    });

    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
        { binding: 1, resource: { buffer: this.linePointsBuffer } },
        { binding: 2, resource: this.paletteTexture.texture.createView() },
        { binding: 3, resource: this.paletteTexture.sampler },
      ],
    });
  }
}
