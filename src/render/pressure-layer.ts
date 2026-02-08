/**
 * PressureLayer - GPU-based isobar contour rendering
 *
 * Compute pipeline:
 * 1. Regrid: O1280 Gaussian → regular grid (1° or 2°)
 * 2. Count: Marching squares segment count per cell
 * 3. Prefix sum: Compute output offsets
 * 4. Generate: Create line segment vertices
 *
 * Render pipeline:
 * - Line-list primitives with depth testing against globe
 * - Day/night tinting, standard pressure highlight
 */

import pressRenderCode from './shaders/press-render.wgsl?raw';
import pressRegridCode from './shaders/press-regrid.wgsl?raw';
import pressContourCode from './shaders/press-contour.wgsl?raw';
import pressPrefixSumCode from './shaders/press-prefix-sum.wgsl?raw';
import pressSmoothCode from './shaders/press-smooth.wgsl?raw';
import pressChaikinCode from './shaders/press-chaikin.wgsl?raw';
import type { PressureColorOption } from '../schemas/options.schema';

/** Smoothing algorithm type */
export type SmoothingAlgorithm = 'laplacian' | 'chaikin';

/** Isobar configuration */
export const ISOBAR_CONFIG = {
  standard: 1012,  // Highlighted isobar (sea level pressure)
  min: 960,
  max: 1040,
  maxLevels: 41,   // Max levels at 2 hPa spacing (for buffer sizing)
} as const;

/** Generate isobar levels for given spacing, always including 1012 */
export function generateIsobarLevels(spacing: number): number[] {
  const { standard, min, max } = ISOBAR_CONFIG;
  const levels: number[] = [];

  // Generate levels below standard
  for (let p = standard; p >= min; p -= spacing) {
    levels.unshift(p);
  }
  // Generate levels above standard (skip standard itself)
  for (let p = standard + spacing; p <= max; p += spacing) {
    levels.push(p);
  }

  return levels;
}

/** Grid resolution options */
export type PressureResolution = 1 | 2;  // degrees

interface PressureUniforms {
  viewProj: Float32Array;
  eyePosition: [number, number, number];
  sunDirection: [number, number, number];
  opacity: number;
}

/** External GPU buffers provided by GlobeRenderer (Gaussian LUTs only) */
export interface PressureExternalBuffers {
  gaussianLats: GPUBuffer;        // 2560 latitudes
  ringOffsets: GPUBuffer;         // 2560 ring offsets
}

// Constants
const EARTH_RADIUS = 1.0;
const SCAN_BLOCK_SIZE = 512;

export class PressureLayer {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private uniformAlignment: number;  // Queried from device.limits

  // Grid dimensions based on resolution
  private resolution: PressureResolution;
  private gridWidth: number;
  private gridHeight: number;
  private numCells: number;

  // External buffers (set via setExternalBuffers)
  private externalBuffers: PressureExternalBuffers | null = null;

  // Compute pipelines
  private regridPipeline!: GPUComputePipeline;
  private countPipeline!: GPUComputePipeline;
  private generatePipeline!: GPUComputePipeline;
  private buildNeighborsPipeline!: GPUComputePipeline;  // Populates neighbor buffer for Chaikin
  private scanBlocksPipeline!: GPUComputePipeline;
  private addBlockSumsPipeline!: GPUComputePipeline;
  private edgeClearPipeline!: GPUComputePipeline;  // Fills edge buffer with -1

  // Compute buffers
  private regridUniformBuffer!: GPUBuffer;
  private contourUniformBuffer!: GPUBuffer;
  private gridSlotBuffers: GPUBuffer[] = [];  // Regridded data per slot
  private gridSlotReady: boolean[] = [];      // Track which slots are regridded
  private hasRawData: boolean[] = [];         // Track which slots have raw data (for re-regrid)
  private segmentCountsBuffer!: GPUBuffer;
  private offsetsBuffer!: GPUBuffer;
  private blockSumsBuffer!: GPUBuffer;
  private blockSums2Buffer!: GPUBuffer;  // Second buffer to avoid aliasing

  // Bind group layouts
  private regridBindGroupLayout!: GPUBindGroupLayout;
  private contourBindGroupLayout!: GPUBindGroupLayout;
  private prefixSumBindGroupLayout!: GPUBindGroupLayout;
  private smoothBindGroupLayout!: GPUBindGroupLayout;
  private edgeClearBindGroupLayout!: GPUBindGroupLayout;
  private edgeClearBindGroup!: GPUBindGroup;

  // Cached contour bind group (invalidated when slots change)
  private contourBindGroup: GPUBindGroup | null = null;
  private contourBindGroupSlots: [number, number] = [-1, -1];

  // Smoothing pipeline and buffers (Laplacian)
  private smoothPipeline!: GPUComputePipeline;
  private smoothUniformBuffer!: GPUBuffer;
  private edgeToVertexBuffer!: GPUBuffer;      // Edge→vertex index mapping
  private smoothedVertexBuffer!: GPUBuffer;    // Output of smoothing pass

  // Chaikin pipeline and buffers
  private chaikinPipeline!: GPUComputePipeline;
  private chaikinBindGroupLayout!: GPUBindGroupLayout;
  private chaikinUniformBuffer!: GPUBuffer;
  private neighborBuffer!: GPUBuffer;          // [prevIdx, nextIdx] per vertex for chain traversal
  private smoothedNeighborBuffer!: GPUBuffer;  // Ping-pong neighbor buffer for Chaikin

  // Render pipeline
  private renderPipeline!: GPURenderPipeline;
  private renderUniformBuffer!: GPUBuffer;
  private renderBindGroup!: GPUBindGroup;
  private renderBindGroupLayout!: GPUBindGroupLayout;

  // Vertex buffer (filled by compute)
  private vertexBuffer!: GPUBuffer;

  // State
  private enabled = false;
  private vertexCount = 0;
  private computeReady = false;
  private currentLevelCount = 21;  // Default for 4 hPa spacing


  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    resolution: PressureResolution
  ) {
    this.device = device;
    this.format = format;
    this.resolution = resolution;
    this.uniformAlignment = device.limits.minUniformBufferOffsetAlignment;

    // Set grid dimensions based on resolution
    this.gridWidth = 360 / resolution;   // 360 (1°) or 180 (2°)
    this.gridHeight = 180 / resolution;  // 180 (1°) or 90 (2°)
    this.numCells = this.gridWidth * (this.gridHeight - 1);  // Extra column for longitude wrap

    this.createComputePipelines();
    this.createComputeBuffers();
    this.createRenderPipeline();
    this.createRenderBuffers();
  }

  private createComputePipelines(): void {
    // Regrid bind group layout
    this.regridBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    // Contour compute bind group layout (dynamic offset for batched uniforms)
    this.contourBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // pressureGrid0
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },  // segmentCounts
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // offsets
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },  // vertices
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // pressureGrid1
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },  // edgeToVertex
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },  // neighborBuffer
      ],
    });

    // Prefix sum bind group layout
    this.prefixSumBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    // Smoothing bind group layout
    this.smoothBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // input vertices
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },            // output vertices
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // edgeToVertex
      ],
    });

    // Regrid pipeline
    const regridModule = this.device.createShaderModule({ code: pressRegridCode });
    this.regridPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.regridBindGroupLayout] }),
      compute: { module: regridModule, entryPoint: 'main' },
    });

    // Contour compute pipelines
    const contourModule = this.device.createShaderModule({ code: pressContourCode });
    this.countPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.contourBindGroupLayout] }),
      compute: { module: contourModule, entryPoint: 'countSegments' },
    });
    this.generatePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.contourBindGroupLayout] }),
      compute: { module: contourModule, entryPoint: 'generateSegments' },
    });
    this.buildNeighborsPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.contourBindGroupLayout] }),
      compute: { module: contourModule, entryPoint: 'buildNeighbors' },
    });

    // Prefix sum pipelines
    const prefixSumModule = this.device.createShaderModule({ code: pressPrefixSumCode });
    this.scanBlocksPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.prefixSumBindGroupLayout] }),
      compute: { module: prefixSumModule, entryPoint: 'scanBlocks' },
    });
    this.addBlockSumsPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.prefixSumBindGroupLayout] }),
      compute: { module: prefixSumModule, entryPoint: 'addBlockSums' },
    });

    // Smoothing pipeline (Laplacian)
    const smoothModule = this.device.createShaderModule({ code: pressSmoothCode });
    this.smoothPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.smoothBindGroupLayout] }),
      compute: { module: smoothModule, entryPoint: 'smoothEdges' },
    });

    // Chaikin pipeline - uses neighbor buffer for chain traversal
    // Uses dynamic offset for per-level uniforms (like contour)
    this.chaikinBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // input vertices
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },            // output vertices
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // input neighbors
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },            // output neighbors
      ],
    });
    const chaikinModule = this.device.createShaderModule({ code: pressChaikinCode });
    this.chaikinPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.chaikinBindGroupLayout] }),
      compute: { module: chaikinModule, entryPoint: 'chaikinSubdivide' },
    });

    // Edge clear pipeline - fills edge buffer with -1 (GPU-side, can be batched)
    this.edgeClearBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const edgeClearModule = this.device.createShaderModule({
      code: `@group(0) @binding(0) var<storage, read_write> edges: array<i32>;
             @compute @workgroup_size(256)
             fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
               if (gid.x < arrayLength(&edges)) { edges[gid.x] = -1; }
             }`,
    });
    this.edgeClearPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.edgeClearBindGroupLayout] }),
      compute: { module: edgeClearModule, entryPoint: 'main' },
    });
  }

  private createComputeBuffers(): void {
    // Regrid uniform buffer
    this.regridUniformBuffer = this.device.createBuffer({
      size: 16,  // 4 u32: outputWidth, outputHeight, inputSlot, pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Contour uniform buffer - sized for max levels with 256-byte alignment for dynamic offsets
    // Struct per level: gridWidth, gridHeight, isovalue, earthRadius, vertexOffset, lerp, _pad(vec2)
    this.contourUniformBuffer = this.device.createBuffer({
      size: this.uniformAlignment * ISOBAR_CONFIG.maxLevels,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,  // COPY_SRC for debug
    });

    // Grid slot buffers created in setExternalBuffers (need to know slot count)

    // Segment counts buffer (padded to multiple of SCAN_BLOCK_SIZE for prefix sum)
    const paddedCells = Math.ceil(this.numCells / SCAN_BLOCK_SIZE) * SCAN_BLOCK_SIZE;
    this.segmentCountsBuffer = this.device.createBuffer({
      size: paddedCells * 4,  // u32 per cell
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Offsets buffer (same size as counts, filled by prefix sum via copy)
    this.offsetsBuffer = this.device.createBuffer({
      size: paddedCells * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Block sums buffers for prefix sum (two to avoid aliasing in Chrome)
    const numBlocks = Math.ceil(paddedCells / SCAN_BLOCK_SIZE);
    const paddedBlocks = Math.ceil(numBlocks / SCAN_BLOCK_SIZE) * SCAN_BLOCK_SIZE;
    const blockSumsSize = Math.max(paddedBlocks * 4, 64);
    this.blockSumsBuffer = this.device.createBuffer({
      size: blockSumsSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.blockSums2Buffer = this.device.createBuffer({
      size: blockSumsSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Max segments per isobar level (worst case: 2 per cell for saddle points)
    const maxSegmentsPerLevel = this.numCells * 2;
    const maxVerticesPerLevel = maxSegmentsPerLevel * 2;  // 2 vertices per segment
    // Chaikin 2× vertices per pass, so 2 passes = 4× expansion
    const maxVerticesWithChaikin = maxVerticesPerLevel * 4;  // 4× for 2 Chaikin passes (2^2)

    // Vertex buffer sized for current level count (with Chaikin expansion room)
    this.vertexBuffer = this.device.createBuffer({
      size: Math.max(maxVerticesWithChaikin * this.currentLevelCount * 16, 64),  // vec4f per vertex
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,  // COPY_SRC for debug
    });

    // Edge→vertex mapping buffer (4 edges per cell, i32 per edge)
    this.edgeToVertexBuffer = this.device.createBuffer({
      size: this.numCells * 4 * 4,  // numCells × 4 edges × 4 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Edge clear bind group (for GPU-side -1 fill)
    this.edgeClearBindGroup = this.device.createBindGroup({
      layout: this.edgeClearBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.edgeToVertexBuffer } }],
    });

    // Smoothed vertex buffer (same size as vertex buffer, for ping-pong)
    this.smoothedVertexBuffer = this.device.createBuffer({
      size: Math.max(maxVerticesWithChaikin * this.currentLevelCount * 16, 64),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Smoothing uniform buffer (16 bytes: gridWidth, gridHeight, numCells, earthRadius)
    this.smoothUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Chaikin uniform buffer - sized for all levels × max passes with dynamic offsets
    // 16 bytes per slot: earthRadius, inputCount, inputOffset, outputOffset
    const maxChaikinPasses = 2;
    this.chaikinUniformBuffer = this.device.createBuffer({
      size: this.uniformAlignment * ISOBAR_CONFIG.maxLevels * maxChaikinPasses,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,  // COPY_SRC for debug
    });

    // Neighbor buffer: [prevIdx, nextIdx] per vertex (2 × i32 = 8 bytes per vertex)
    // Same vertex count as vertexBuffer (with Chaikin expansion room)
    const neighborBufferSize = Math.max(maxVerticesWithChaikin * this.currentLevelCount * 8, 64);
    this.neighborBuffer = this.device.createBuffer({
      size: neighborBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.smoothedNeighborBuffer = this.device.createBuffer({
      size: neighborBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
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
    const renderModule = this.device.createShaderModule({ code: pressRenderCode });
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

  private createRenderBuffers(): void {
    // Render uniform buffer (viewProj + eyePos + sunDir + opacity + colorMode + pressure range + 3 colors)
    this.renderUniformBuffer = this.device.createBuffer({
      size: 192,  // mat4(64) + vec3+pad(16) + vec3+f32(16) + u32+3f32(16) + 3×vec4(48) = 160, pad to 192
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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
   * Set external GPU buffers from GlobeRenderer (Gaussian LUTs)
   * Grid slot buffers are created on demand in regridSlot()
   */
  setExternalBuffers(buffers: PressureExternalBuffers): void {
    this.externalBuffers = buffers;
    this.computeReady = true;
  }

  /**
   * Ensure grid slot buffer exists for a given slot index
   * Creates buffer on demand (per-slot mode)
   */
  private ensureGridSlotBuffer(slotIndex: number): void {
    while (this.gridSlotBuffers.length <= slotIndex) {
      const gridSlotSize = this.gridWidth * this.gridHeight * 4;  // f32 per cell
      this.gridSlotBuffers.push(this.device.createBuffer({
        size: gridSlotSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        label: `pressure-grid-slot${this.gridSlotBuffers.length}`,
      }));
      this.gridSlotReady.push(false);
      this.hasRawData.push(false);
    }
  }

  /**
   * Mark a grid slot as needing regrid (called when raw slot updated)
   */
  invalidateGridSlot(slotIndex: number): void {
    if (slotIndex >= 0 && slotIndex < this.gridSlotBuffers.length) {
      this.gridSlotReady[slotIndex] = false;
    }
  }

  /**
   * Invalidate all grid slots (called when slot indices are renumbered during shrink)
   */
  invalidateAllGridSlots(): void {
    for (let i = 0; i < this.gridSlotReady.length; i++) {
      this.gridSlotReady[i] = false;
    }
  }

  /**
   * Check if a grid slot is ready (regridded)
   */
  isGridSlotReady(slotIndex: number): boolean {
    return slotIndex >= 0 && slotIndex < this.gridSlotBuffers.length && this.gridSlotReady[slotIndex] === true;
  }

  /**
   * Change resolution live - recreates all resolution-dependent buffers
   * Returns slot indices that need regrid (have raw data)
   */
  setResolution(resolution: PressureResolution): number[] {
    if (resolution === this.resolution) return [];
    if (!this.computeReady) {
      console.warn('[Pressure] Cannot change resolution - not ready');
      return [];
    }

    const slotCount = this.gridSlotBuffers.length;
    this.resolution = resolution;

    // Update dimensions
    this.gridWidth = 360 / resolution;
    this.gridHeight = 180 / resolution;
    this.numCells = this.gridWidth * (this.gridHeight - 1);

    // Destroy old grid slot buffers and recreate with new size
    for (const buffer of this.gridSlotBuffers) {
      buffer.destroy();
    }
    const gridSlotSize = (360 / resolution) * (180 / resolution) * 4;
    this.gridSlotBuffers = [];
    this.gridSlotReady = [];
    for (let i = 0; i < slotCount; i++) {
      this.gridSlotBuffers.push(this.device.createBuffer({
        size: gridSlotSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        label: `pressure-grid-slot${i}`,
      }));
      this.gridSlotReady.push(false);
    }
    // Keep hasRawData - raw slots still have data that needs regridding
    // (caller should trigger regrid for active slots)

    // Invalidate cached bind group (references buffers being destroyed)
    this.contourBindGroup = null;
    this.contourBindGroupSlots = [-1, -1];

    // Destroy and recreate compute buffers
    this.segmentCountsBuffer.destroy();
    this.offsetsBuffer.destroy();
    this.blockSumsBuffer.destroy();
    this.blockSums2Buffer.destroy();
    this.vertexBuffer.destroy();
    this.edgeToVertexBuffer.destroy();
    this.smoothedVertexBuffer.destroy();

    // Recreate compute buffers (same logic as createComputeBuffers)
    const paddedCells = Math.ceil(this.numCells / SCAN_BLOCK_SIZE) * SCAN_BLOCK_SIZE;
    this.segmentCountsBuffer = this.device.createBuffer({
      size: paddedCells * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.offsetsBuffer = this.device.createBuffer({
      size: paddedCells * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const numBlocks = Math.ceil(paddedCells / SCAN_BLOCK_SIZE);
    const paddedBlocks = Math.ceil(numBlocks / SCAN_BLOCK_SIZE) * SCAN_BLOCK_SIZE;
    const blockSumsSize = Math.max(paddedBlocks * 4, 64);
    this.blockSumsBuffer = this.device.createBuffer({
      size: blockSumsSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.blockSums2Buffer = this.device.createBuffer({
      size: blockSumsSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Recreate vertex buffer (sized for current level count with Chaikin expansion)
    const maxSegmentsPerLevel = this.numCells * 2;
    const maxVerticesPerLevel = maxSegmentsPerLevel * 2;
    const maxVerticesWithChaikin = maxVerticesPerLevel * 4;  // 4× for 2 Chaikin passes (2^2)
    this.vertexBuffer = this.device.createBuffer({
      size: Math.max(maxVerticesWithChaikin * this.currentLevelCount * 16, 64),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,  // COPY_SRC for debug
    });

    // Recreate smoothing buffers
    this.edgeToVertexBuffer = this.device.createBuffer({
      size: this.numCells * 4 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.edgeClearBindGroup = this.device.createBindGroup({
      layout: this.edgeClearBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.edgeToVertexBuffer } }],
    });
    this.smoothedVertexBuffer = this.device.createBuffer({
      size: Math.max(maxVerticesWithChaikin * this.currentLevelCount * 16, 64),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const neighborBufferSize = Math.max(maxVerticesWithChaikin * this.currentLevelCount * 8, 64);
    this.neighborBuffer = this.device.createBuffer({
      size: neighborBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.smoothedNeighborBuffer = this.device.createBuffer({
      size: neighborBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Recreate render bind group (references vertexBuffer)
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
        { binding: 1, resource: { buffer: this.vertexBuffer } },
      ],
    });

    // Return slots that need regrid (have raw data)
    const needsRegrid = this.hasRawData
      .map((has, i) => has ? i : -1)
      .filter(i => i >= 0);
    return needsRegrid;
  }

  /**
   * Update level count and recreate vertex buffer if it grew
   */
  setLevelCount(levelCount: number): void {
    if (levelCount === this.currentLevelCount) return;

    const oldCount = this.currentLevelCount;
    this.currentLevelCount = levelCount;

    // Only recreate if new count is larger (smaller fits in existing buffer)
    if (levelCount > oldCount) {
      // Invalidate cached bind group (references buffer being destroyed)
      this.contourBindGroup = null;
      this.contourBindGroupSlots = [-1, -1];

      this.vertexBuffer.destroy();
      this.smoothedVertexBuffer.destroy();
      this.neighborBuffer.destroy();
      this.smoothedNeighborBuffer.destroy();

      const maxSegmentsPerLevel = this.numCells * 2;
      const maxVerticesPerLevel = maxSegmentsPerLevel * 2;
      const maxVerticesWithChaikin = maxVerticesPerLevel * 4;  // 4× for 2 Chaikin passes (2^2)
      this.vertexBuffer = this.device.createBuffer({
        size: Math.max(maxVerticesWithChaikin * this.currentLevelCount * 16, 64),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,  // COPY_SRC for debug
      });
      this.smoothedVertexBuffer = this.device.createBuffer({
        size: Math.max(maxVerticesWithChaikin * this.currentLevelCount * 16, 64),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      const neighborBufferSize = Math.max(maxVerticesWithChaikin * this.currentLevelCount * 8, 64);
      this.neighborBuffer = this.device.createBuffer({
        size: neighborBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      this.smoothedNeighborBuffer = this.device.createBuffer({
        size: neighborBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });

      // Recreate render bind group (references vertexBuffer)
      this.renderBindGroup = this.device.createBindGroup({
        layout: this.renderBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.renderUniformBuffer } },
          { binding: 1, resource: { buffer: this.vertexBuffer } },
        ],
      });

    }
  }

  /**
   * Run regrid compute for a single slot (raw → grid)
   * @param slotIndex Grid slot index for output
   * @param inputBuffer Per-slot buffer containing O1280 raw data
   */
  regridSlot(slotIndex: number, inputBuffer: GPUBuffer): void {
    if (!this.computeReady || !this.externalBuffers) {
      console.warn('[Pressure] Compute not ready - call setExternalBuffers first');
      return;
    }

    // Ensure grid slot buffer exists
    this.ensureGridSlotBuffer(slotIndex);

    // Update regrid uniforms (inputSlot=0 for per-slot mode, data starts at offset 0)
    const regridUniforms = new Uint32Array([
      this.gridWidth,
      this.gridHeight,
      0,  // inputSlot=0 (per-slot buffer, no offset)
      0,
    ]);
    this.device.queue.writeBuffer(this.regridUniformBuffer, 0, regridUniforms);

    // Create regrid bind group with per-slot input buffer
    const regridBindGroup = this.device.createBindGroup({
      layout: this.regridBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.regridUniformBuffer } },
        { binding: 1, resource: { buffer: inputBuffer } },
        { binding: 2, resource: { buffer: this.externalBuffers.gaussianLats } },
        { binding: 3, resource: { buffer: this.externalBuffers.ringOffsets } },
        { binding: 4, resource: { buffer: this.gridSlotBuffers[slotIndex]! } },
      ],
    });

    // Run regrid
    const commandEncoder = this.device.createCommandEncoder();
    const regridPass = commandEncoder.beginComputePass();
    regridPass.setPipeline(this.regridPipeline);
    regridPass.setBindGroup(0, regridBindGroup);
    regridPass.dispatchWorkgroups(
      Math.ceil(this.gridWidth / 8),
      Math.ceil(this.gridHeight / 8)
    );
    regridPass.end();
    this.device.queue.submit([commandEncoder.finish()]);

    this.gridSlotReady[slotIndex] = true;
    this.hasRawData[slotIndex] = true;
  }

  /**
   * Get base vertices per level (before Chaikin expansion)
   * This is numCells * 4 (max 2 segments per cell, 2 vertices per segment)
   */
  getBaseVerticesPerLevel(): number {
    return this.numCells * 4;
  }

  /**
   * Prepare contour batch - writes all uniforms and clears buffers once
   * Call before the per-level loop, then call runContourLevel for each level
   * @param slot0 First grid slot index
   * @param slot1 Second grid slot index
   * @param lerp Interpolation factor (0 = slot0, 1 = slot1)
   * @param levels Array of pressure levels in hPa
   * @param maxVerticesPerLevel Max vertices per isobar level
   */
  prepareContourBatch(
    slot0: number,
    slot1: number,
    lerp: number,
    levels: number[],
    maxVerticesPerLevel: number
  ): void {
    if (!this.computeReady || !this.externalBuffers) {
      console.warn('[Pressure] Compute not ready');
      return;
    }

    // Write all uniforms at once (256-byte aligned per level)
    for (let i = 0; i < levels.length; i++) {
      const contourUniforms = new ArrayBuffer(32);
      const contourU32 = new Uint32Array(contourUniforms);
      const contourF32 = new Float32Array(contourUniforms);
      contourU32[0] = this.gridWidth;
      contourU32[1] = this.gridHeight;
      contourF32[2] = levels[i]! * 100;  // hPa to Pa
      contourF32[3] = EARTH_RADIUS;
      contourU32[4] = i * maxVerticesPerLevel;  // vertexOffset
      contourF32[5] = lerp;
      this.device.queue.writeBuffer(this.contourUniformBuffer, i * this.uniformAlignment, contourUniforms);
    }

    // Clear segment counts padding once (edge buffer cleared per-level via compute)
    const paddedCells = Math.ceil(this.numCells / SCAN_BLOCK_SIZE) * SCAN_BLOCK_SIZE;
    const clearData = new Uint32Array(paddedCells - this.numCells);
    if (clearData.length > 0) {
      this.device.queue.writeBuffer(this.segmentCountsBuffer, this.numCells * 4, clearData);
    }

    // Create/cache contour bind group (invalidate if slots changed)
    // For dynamic offset uniforms, specify size=uniformAlignment (the visible window per offset)
    if (!this.contourBindGroup ||
        this.contourBindGroupSlots[0] !== slot0 ||
        this.contourBindGroupSlots[1] !== slot1) {
      this.contourBindGroup = this.device.createBindGroup({
        layout: this.contourBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.contourUniformBuffer, size: this.uniformAlignment } },
          { binding: 1, resource: { buffer: this.gridSlotBuffers[slot0]! } },
          { binding: 2, resource: { buffer: this.segmentCountsBuffer } },
          { binding: 3, resource: { buffer: this.offsetsBuffer } },
          { binding: 4, resource: { buffer: this.vertexBuffer } },
          { binding: 5, resource: { buffer: this.gridSlotBuffers[slot1]! } },
          { binding: 6, resource: { buffer: this.edgeToVertexBuffer } },
          { binding: 7, resource: { buffer: this.neighborBuffer } },
        ],
      });
      this.contourBindGroupSlots = [slot0, slot1];
    }
  }

  /**
   * Run contour compute for a single level (call after prepareContourBatch)
   * @param commandEncoder GPU command encoder
   * @param levelIndex Index into the levels array (0 to levels.length-1)
   */
  runContourLevel(commandEncoder: GPUCommandEncoder, levelIndex: number): void {
    if (!this.contourBindGroup) {
      console.warn('[Pressure] Call prepareContourBatch first');
      return;
    }

    const dynamicOffset = levelIndex * this.uniformAlignment;
    const paddedCells = Math.ceil(this.numCells / SCAN_BLOCK_SIZE) * SCAN_BLOCK_SIZE;
    const numBlocks = Math.ceil(paddedCells / SCAN_BLOCK_SIZE);
    const edgeBufferSize = this.numCells * 4;  // 4 edges per cell

    // Clear edge buffer with -1 via compute (GPU-side, maintains batching)
    const edgeClearPass = commandEncoder.beginComputePass();
    edgeClearPass.setPipeline(this.edgeClearPipeline);
    edgeClearPass.setBindGroup(0, this.edgeClearBindGroup);
    edgeClearPass.dispatchWorkgroups(Math.ceil(edgeBufferSize / 256));
    edgeClearPass.end();

    // Pass 1: Count segments per cell
    const countPass = commandEncoder.beginComputePass();
    countPass.setPipeline(this.countPipeline);
    countPass.setBindGroup(0, this.contourBindGroup, [dynamicOffset]);
    countPass.dispatchWorkgroups(
      Math.ceil(this.gridWidth / 8),
      Math.ceil((this.gridHeight - 1) / 8)
    );
    countPass.end();

    // Pass 2: Prefix sum
    const prefixSumBindGroup = this.device.createBindGroup({
      layout: this.prefixSumBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.segmentCountsBuffer } },
        { binding: 1, resource: { buffer: this.blockSumsBuffer } },
      ],
    });

    const scanPass = commandEncoder.beginComputePass();
    scanPass.setPipeline(this.scanBlocksPipeline);
    scanPass.setBindGroup(0, prefixSumBindGroup);
    scanPass.dispatchWorkgroups(numBlocks);
    scanPass.end();

    if (numBlocks > 1) {
      const blockSumsBindGroup = this.device.createBindGroup({
        layout: this.prefixSumBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.blockSumsBuffer } },
          { binding: 1, resource: { buffer: this.blockSums2Buffer } },
        ],
      });

      const scanBlockSumsPass = commandEncoder.beginComputePass();
      scanBlockSumsPass.setPipeline(this.scanBlocksPipeline);
      scanBlockSumsPass.setBindGroup(0, blockSumsBindGroup);
      scanBlockSumsPass.dispatchWorkgroups(1);
      scanBlockSumsPass.end();

      const addBackBindGroup = this.device.createBindGroup({
        layout: this.prefixSumBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.segmentCountsBuffer } },
          { binding: 1, resource: { buffer: this.blockSumsBuffer } },
        ],
      });

      const addPass = commandEncoder.beginComputePass();
      addPass.setPipeline(this.addBlockSumsPipeline);
      addPass.setBindGroup(0, addBackBindGroup);
      addPass.dispatchWorkgroups(numBlocks);
      addPass.end();
    }

    // Copy counts to offsets
    commandEncoder.copyBufferToBuffer(
      this.segmentCountsBuffer, 0,
      this.offsetsBuffer, 0,
      paddedCells * 4
    );

    // Pass 3: Generate vertices
    const generatePass = commandEncoder.beginComputePass();
    generatePass.setPipeline(this.generatePipeline);
    generatePass.setBindGroup(0, this.contourBindGroup, [dynamicOffset]);
    generatePass.dispatchWorkgroups(
      Math.ceil(this.gridWidth / 8),
      Math.ceil((this.gridHeight - 1) / 8)
    );
    generatePass.end();

    // Pass 4: Build neighbor indices for Chaikin (after edgeToVertex is populated)
    const buildNeighborsPass = commandEncoder.beginComputePass();
    buildNeighborsPass.setPipeline(this.buildNeighborsPipeline);
    buildNeighborsPass.setBindGroup(0, this.contourBindGroup, [dynamicOffset]);
    buildNeighborsPass.dispatchWorkgroups(
      Math.ceil(this.gridWidth / 8),
      Math.ceil((this.gridHeight - 1) / 8)
    );
    buildNeighborsPass.end();
  }

  /**
   * Run smoothing passes on generated contour vertices
   * @param commandEncoder GPU command encoder
   * @param algorithm 'laplacian' or 'chaikin'
   * @param iterations Number of smoothing iterations (0-2)
   * @param vertexOffset Base vertex index for current level
   * @param vertexCount Actual vertex count for current level
   * @param levelIndex Index of current level (for Chaikin dynamic uniforms)
   * @returns New vertex count after smoothing (Chaikin doubles per pass)
   */
  runSmoothing(
    commandEncoder: GPUCommandEncoder,
    algorithm: SmoothingAlgorithm,
    iterations: number,
    vertexOffset: number,
    vertexCount: number,
    levelIndex: number
  ): number {
    if (iterations <= 0 || !this.computeReady) return vertexCount;

    if (algorithm === 'laplacian') {
      return this.runLaplacianSmoothing(commandEncoder, iterations, vertexOffset, vertexCount);
    } else {
      return this.runChaikinSmoothing(commandEncoder, iterations, vertexOffset, vertexCount, levelIndex);
    }
  }

  /**
   * Laplacian smoothing - moves vertices toward neighbors, same vertex count
   */
  private runLaplacianSmoothing(
    commandEncoder: GPUCommandEncoder,
    iterations: number,
    vertexOffset: number,
    vertexCount: number
  ): number {
    // Clear the smoothed buffer region
    const byteOffset = vertexOffset * 16;
    const byteSize = vertexCount * 16;
    commandEncoder.clearBuffer(this.smoothedVertexBuffer, byteOffset, byteSize);

    // Update smoothing uniforms
    const smoothUniforms = new Uint32Array([
      this.gridWidth,
      this.gridHeight,
      this.numCells,
      0,  // earthRadius as u32 bits - will be overwritten
    ]);
    const smoothF32 = new Float32Array(smoothUniforms.buffer);
    smoothF32[3] = EARTH_RADIUS;
    this.device.queue.writeBuffer(this.smoothUniformBuffer, 0, smoothUniforms);

    // Ping-pong between vertex buffer and smoothed buffer
    let inputBuffer = this.vertexBuffer;
    let outputBuffer = this.smoothedVertexBuffer;

    for (let i = 0; i < iterations; i++) {
      const smoothBindGroup = this.device.createBindGroup({
        layout: this.smoothBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.smoothUniformBuffer } },
          { binding: 1, resource: { buffer: inputBuffer } },
          { binding: 2, resource: { buffer: outputBuffer } },
          { binding: 3, resource: { buffer: this.edgeToVertexBuffer } },
        ],
      });

      const smoothPass = commandEncoder.beginComputePass();
      smoothPass.setPipeline(this.smoothPipeline);
      smoothPass.setBindGroup(0, smoothBindGroup);
      smoothPass.dispatchWorkgroups(
        Math.ceil(this.gridWidth / 8),
        Math.ceil((this.gridHeight - 1) / 8)
      );
      smoothPass.end();

      // Swap buffers for next iteration
      [inputBuffer, outputBuffer] = [outputBuffer, inputBuffer];
    }

    // If odd iterations, copy result back to vertexBuffer
    if (iterations % 2 === 1) {
      commandEncoder.copyBufferToBuffer(
        this.smoothedVertexBuffer, byteOffset,
        this.vertexBuffer, byteOffset,
        byteSize
      );
    }

    return vertexCount;  // Laplacian doesn't change count
  }

  /**
   * Chaikin corner-cutting - doubles vertex count per pass
   * Processes per-segment, outputs 2 corner segments (4 vertices) per input segment (2 vertices)
   */
  private runChaikinSmoothing(
    commandEncoder: GPUCommandEncoder,
    iterations: number,
    vertexOffset: number,
    vertexCount: number,
    levelIndex: number
  ): number {
    let currentCount = vertexCount;
    let currentOffset = vertexOffset;

    // Write uniforms for ALL passes upfront (queue.writeBuffer is CPU-immediate)
    // Each pass needs its own uniform slot: level * maxPasses + passIndex
    const maxPasses = 2;
    const chaikinUniforms = new ArrayBuffer(32);  // 8 x u32/f32
    const f32 = new Float32Array(chaikinUniforms);
    const u32 = new Uint32Array(chaikinUniforms);

    let precomputeCount = currentCount;
    for (let p = 0; p < iterations; p++) {
      const dynamicOffset = (levelIndex * maxPasses + p) * this.uniformAlignment;
      f32[0] = EARTH_RADIUS;
      u32[1] = precomputeCount;
      u32[2] = currentOffset;
      u32[3] = currentOffset;
      u32[4] = p;  // passNumber: 0 = pass 1, 1 = pass 2
      u32[5] = 0;  // padding
      u32[6] = 0;  // padding
      u32[7] = 0;  // padding
      this.device.queue.writeBuffer(this.chaikinUniformBuffer, dynamicOffset, chaikinUniforms);
      precomputeCount *= 2;  // Next pass has 2× vertices
    }

    // Ping-pong between vertex/neighbor buffer pairs
    let inputVertexBuffer = this.vertexBuffer;
    let outputVertexBuffer = this.smoothedVertexBuffer;
    let inputNeighborBuffer = this.neighborBuffer;
    let outputNeighborBuffer = this.smoothedNeighborBuffer;

    for (let i = 0; i < iterations; i++) {
      const dynamicOffset = (levelIndex * maxPasses + i) * this.uniformAlignment;
      const numSegments = currentCount / 2;
      const outputCount = currentCount * 2;  // 4 vertices per 2 input = 2× expansion
      const outputOffset = currentOffset;

      // Clear output regions (vertices: 16 bytes, neighbors: 8 bytes per vertex)
      const outVertexByteOffset = outputOffset * 16;
      const outVertexByteSize = outputCount * 16;
      const outNeighborByteOffset = outputOffset * 8;
      const outNeighborByteSize = outputCount * 8;
      commandEncoder.clearBuffer(outputVertexBuffer, outVertexByteOffset, outVertexByteSize);
      commandEncoder.clearBuffer(outputNeighborBuffer, outNeighborByteOffset, outNeighborByteSize);

      // Create bind group for this iteration (buffers swap for ping-pong)
      const chaikinBindGroup = this.device.createBindGroup({
        layout: this.chaikinBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.chaikinUniformBuffer, size: this.uniformAlignment } },
          { binding: 1, resource: { buffer: inputVertexBuffer } },
          { binding: 2, resource: { buffer: outputVertexBuffer } },
          { binding: 3, resource: { buffer: inputNeighborBuffer } },
          { binding: 4, resource: { buffer: outputNeighborBuffer } },
        ],
      });

      // Dispatch over segments (workgroup size 256)
      const chaikinPass = commandEncoder.beginComputePass();
      chaikinPass.setPipeline(this.chaikinPipeline);
      chaikinPass.setBindGroup(0, chaikinBindGroup, [dynamicOffset]);
      chaikinPass.dispatchWorkgroups(Math.ceil(numSegments / 256));
      chaikinPass.end();

      // Update for next iteration
      currentCount = outputCount;

      // Swap buffer pairs for next iteration
      [inputVertexBuffer, outputVertexBuffer] = [outputVertexBuffer, inputVertexBuffer];
      [inputNeighborBuffer, outputNeighborBuffer] = [outputNeighborBuffer, inputNeighborBuffer];
    }

    // If odd iterations, copy results back to primary buffers
    if (iterations % 2 === 1) {
      const vertexByteOffset = currentOffset * 16;
      const vertexByteSize = currentCount * 16;
      const neighborByteOffset = currentOffset * 8;
      const neighborByteSize = currentCount * 8;
      commandEncoder.copyBufferToBuffer(
        this.smoothedVertexBuffer, vertexByteOffset,
        this.vertexBuffer, vertexByteOffset,
        vertexByteSize
      );
      commandEncoder.copyBufferToBuffer(
        this.smoothedNeighborBuffer, neighborByteOffset,
        this.neighborBuffer, neighborByteOffset,
        neighborByteSize
      );
    }

    return currentCount;  // Chaikin returns expanded count
  }

  /**
   * Update render uniforms
   */
  updateUniforms(uniforms: PressureUniforms, colorOption: PressureColorOption): void {
    const uniformData = new ArrayBuffer(192);
    const floatView = new Float32Array(uniformData);
    const uintView = new Uint32Array(uniformData);

    // viewProj (16 floats) - offset 0
    floatView.set(uniforms.viewProj, 0);
    // eyePosition (3 floats + 1 pad) - offset 16
    floatView.set(uniforms.eyePosition, 16);
    // sunDirection (3 floats) + opacity (1 float) - offset 20
    floatView.set(uniforms.sunDirection, 20);
    floatView[23] = uniforms.opacity;

    // Color mode and pressure range - offset 24
    // Symmetric range around 1012: ±36 hPa for balanced gradient
    const modeMap = { solid: 0, gradient: 1, normal: 2, debug: 3 } as const;
    uintView[24] = modeMap[colorOption.mode];
    floatView[25] = 97600;   // pressureMin (976 hPa)
    floatView[26] = 104800;  // pressureMax (1048 hPa)
    floatView[27] = 101200;  // pressureRef (1012 hPa)

    // Colors - offset 28 (vec4 each = 4 floats)
    if (colorOption.mode !== 'debug') {
      const colors = colorOption.colors;
      floatView.set(colors[0], 28);                           // color0
      floatView.set(colors[1] ?? [1, 1, 1, 1], 32);           // color1
      floatView.set(colors[2] ?? [1, 1, 1, 1], 36);           // color2
    } else {
      // Debug mode: colors not used, but set defaults
      floatView.set([1, 1, 1, 1], 28);
      floatView.set([1, 1, 1, 1], 32);
      floatView.set([1, 1, 1, 1], 36);
    }

    this.device.queue.writeBuffer(this.renderUniformBuffer, 0, uniformData);
  }

  /**
   * Set test vertices for visual debugging (CPU upload)
   * Use this to verify render pipeline before compute is wired up
   */
  setTestVertices(vertices: Float32Array): void {
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices.buffer, vertices.byteOffset, vertices.byteLength);
    this.vertexCount = vertices.length / 4;  // vec4f per vertex
  }

  /**
   * Set vertex count after compute pass
   * In a real implementation this would come from GPU readback
   */
  setVertexCount(count: number): void {
    this.vertexCount = count;
  }

  /**
   * Clear vertex buffer using GPU-side clearBuffer (fast, no CPU→GPU transfer)
   * Called before recomputing contours
   * @param chaikinExpansion Expansion factor for Chaikin (2^iterations), default 1
   */
  clearVertexBuffer(commandEncoder: GPUCommandEncoder, chaikinExpansion: number = 1): void {
    const maxSegmentsPerLevel = this.numCells * 2;
    const maxVerticesPerLevel = maxSegmentsPerLevel * 2 * chaikinExpansion;
    const byteSize = maxVerticesPerLevel * this.currentLevelCount * 16;  // vec4f = 16 bytes
    commandEncoder.clearBuffer(this.vertexBuffer, 0, byteSize);
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

  isComputeReady(): boolean {
    return this.computeReady;
  }

  dispose(): void {
    // Compute buffers
    this.regridUniformBuffer?.destroy();
    this.contourUniformBuffer?.destroy();
    for (const buf of this.gridSlotBuffers) buf?.destroy();
    this.segmentCountsBuffer?.destroy();
    this.offsetsBuffer?.destroy();
    this.blockSumsBuffer?.destroy();
    this.blockSums2Buffer?.destroy();

    // Smoothing buffers
    this.smoothUniformBuffer?.destroy();
    this.chaikinUniformBuffer?.destroy();
    this.edgeToVertexBuffer?.destroy();
    this.smoothedVertexBuffer?.destroy();
    this.neighborBuffer?.destroy();
    this.smoothedNeighborBuffer?.destroy();

    // Render buffers
    this.renderUniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
  }
}
