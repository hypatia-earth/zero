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
  private scanBlocksPipeline!: GPUComputePipeline;
  private addBlockSumsPipeline!: GPUComputePipeline;

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

  // Smoothing pipeline and buffers
  private smoothPipeline!: GPUComputePipeline;
  private smoothUniformBuffer!: GPUBuffer;
  private edgeToVertexBuffer!: GPUBuffer;      // Edge→vertex index mapping
  private smoothedVertexBuffer!: GPUBuffer;    // Output of smoothing pass

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

    // Contour compute bind group layout
    this.contourBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // pressureGrid0
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // pressureGrid1
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },  // edgeToVertex
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

    // Smoothing pipeline
    const smoothModule = this.device.createShaderModule({ code: pressSmoothCode });
    this.smoothPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.smoothBindGroupLayout] }),
      compute: { module: smoothModule, entryPoint: 'smoothEdges' },
    });
  }

  private createComputeBuffers(): void {
    // Regrid uniform buffer
    this.regridUniformBuffer = this.device.createBuffer({
      size: 16,  // 4 u32: outputWidth, outputHeight, inputSlot, pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Contour uniform buffer (32 bytes)
    // Struct: gridWidth, gridHeight, isovalue, earthRadius, vertexOffset, lerp, _pad(vec2)
    this.contourUniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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

    // Vertex buffer sized for current level count
    this.vertexBuffer = this.device.createBuffer({
      size: Math.max(maxVerticesPerLevel * this.currentLevelCount * 16, 64),  // vec4f per vertex
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Edge→vertex mapping buffer (4 edges per cell, i32 per edge)
    this.edgeToVertexBuffer = this.device.createBuffer({
      size: this.numCells * 4 * 4,  // numCells × 4 edges × 4 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Smoothed vertex buffer (same size as vertex buffer, for ping-pong)
    this.smoothedVertexBuffer = this.device.createBuffer({
      size: Math.max(maxVerticesPerLevel * this.currentLevelCount * 16, 64),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Smoothing uniform buffer (16 bytes: gridWidth, gridHeight, numCells, earthRadius)
    this.smoothUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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
    // Render uniform buffer (viewProj + eyePos + sunDir + opacity + isStandard)
    this.renderUniformBuffer = this.device.createBuffer({
      size: 128,  // mat4 + vec3 + pad + vec3 + f32 + u32 + vec3 pad
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
    console.log(`[Pressure] External buffers set (per-slot mode)`);
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
        usage: GPUBufferUsage.STORAGE,
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
    console.log(`[Pressure] Changing resolution: ${this.resolution}° → ${resolution}°`);
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
        usage: GPUBufferUsage.STORAGE,
        label: `pressure-grid-slot${i}`,
      }));
      this.gridSlotReady.push(false);
    }
    // Keep hasRawData - raw slots still have data that needs regridding
    // (caller should trigger regrid for active slots)

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

    // Recreate vertex buffer (sized for current level count)
    const maxSegmentsPerLevel = this.numCells * 2;
    const maxVerticesPerLevel = maxSegmentsPerLevel * 2;
    this.vertexBuffer = this.device.createBuffer({
      size: Math.max(maxVerticesPerLevel * this.currentLevelCount * 16, 64),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Recreate smoothing buffers
    this.edgeToVertexBuffer = this.device.createBuffer({
      size: this.numCells * 4 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.smoothedVertexBuffer = this.device.createBuffer({
      size: Math.max(maxVerticesPerLevel * this.currentLevelCount * 16, 64),
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

    const totalKB = (gridSlotSize * slotCount / 1024).toFixed(0);

    // Return slots that need regrid (have raw data)
    const needsRegrid = this.hasRawData
      .map((has, i) => has ? i : -1)
      .filter(i => i >= 0);
    console.log(`[Pressure] New grid: ${this.gridWidth}×${this.gridHeight}, ~${totalKB} KB (${needsRegrid.length} slots need regrid)`);
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
      this.vertexBuffer.destroy();

      const maxSegmentsPerLevel = this.numCells * 2;
      const maxVerticesPerLevel = maxSegmentsPerLevel * 2;
      this.vertexBuffer = this.device.createBuffer({
        size: Math.max(maxVerticesPerLevel * this.currentLevelCount * 16, 64),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      // Recreate render bind group (references vertexBuffer)
      this.renderBindGroup = this.device.createBindGroup({
        layout: this.renderBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.renderUniformBuffer } },
          { binding: 1, resource: { buffer: this.vertexBuffer } },
        ],
      });

      console.log(`[Pressure] Vertex buffer resized for ${levelCount} levels`);
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
    console.log(`[Pressure] Regrid slot ${slotIndex} → ${this.gridWidth}×${this.gridHeight}`);
  }

  /**
   * Run contour compute with interpolation between two grid slots
   * @param slot0 First grid slot index
   * @param slot1 Second grid slot index (same as slot0 for single mode)
   * @param lerp Interpolation factor (0 = slot0, 1 = slot1)
   * @param isovalue Pressure level in Pa
   * @param vertexOffset Base vertex index for multi-level rendering
   */
  runContour(
    commandEncoder: GPUCommandEncoder,
    slot0: number,
    slot1: number,
    lerp: number,
    isovalue: number,
    vertexOffset: number
  ): void {
    if (!this.computeReady || !this.externalBuffers) {
      console.warn('[Pressure] Compute not ready');
      return;
    }

    // Update contour uniforms (32 bytes)
    // Struct: gridWidth(u32), gridHeight(u32), isovalue(f32), earthRadius(f32),
    //         vertexOffset(u32), lerp(f32), _pad(vec2<u32>)
    const contourUniforms = new ArrayBuffer(32);
    const contourU32 = new Uint32Array(contourUniforms);
    const contourF32 = new Float32Array(contourUniforms);
    contourU32[0] = this.gridWidth;
    contourU32[1] = this.gridHeight;
    contourF32[2] = isovalue;
    contourF32[3] = EARTH_RADIUS;
    contourU32[4] = vertexOffset;
    contourF32[5] = lerp;
    // _pad: vec2<u32> at offset 24-31
    this.device.queue.writeBuffer(this.contourUniformBuffer, 0, contourUniforms);

    // Clear edge→vertex mapping (fill with -1)
    const edgeClearData = new Int32Array(this.numCells * 4).fill(-1);
    this.device.queue.writeBuffer(this.edgeToVertexBuffer, 0, edgeClearData);

    // Create contour bind group with both grid slots
    const contourBindGroup = this.device.createBindGroup({
      layout: this.contourBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.contourUniformBuffer } },
        { binding: 1, resource: { buffer: this.gridSlotBuffers[slot0]! } },
        { binding: 2, resource: { buffer: this.segmentCountsBuffer } },
        { binding: 3, resource: { buffer: this.offsetsBuffer } },
        { binding: 4, resource: { buffer: this.vertexBuffer } },
        { binding: 5, resource: { buffer: this.gridSlotBuffers[slot1]! } },
        { binding: 6, resource: { buffer: this.edgeToVertexBuffer } },
      ],
    });

    // Create prefix sum bind group
    const prefixSumBindGroup = this.device.createBindGroup({
      layout: this.prefixSumBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.segmentCountsBuffer } },
        { binding: 1, resource: { buffer: this.blockSumsBuffer } },
      ],
    });

    // Clear segment counts padding
    const paddedCells = Math.ceil(this.numCells / SCAN_BLOCK_SIZE) * SCAN_BLOCK_SIZE;
    const clearData = new Uint32Array(paddedCells - this.numCells);
    if (clearData.length > 0) {
      this.device.queue.writeBuffer(this.segmentCountsBuffer, this.numCells * 4, clearData);
    }

    // Pass 1: Count segments per cell (gridWidth includes wrap column)
    const countPass = commandEncoder.beginComputePass();
    countPass.setPipeline(this.countPipeline);
    countPass.setBindGroup(0, contourBindGroup);
    countPass.dispatchWorkgroups(
      Math.ceil(this.gridWidth / 8),
      Math.ceil((this.gridHeight - 1) / 8)
    );
    countPass.end();

    // Pass 2: Prefix sum
    const numBlocks = Math.ceil(paddedCells / SCAN_BLOCK_SIZE);
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

    // Pass 3: Generate vertices (gridWidth includes wrap column)
    const generatePass = commandEncoder.beginComputePass();
    generatePass.setPipeline(this.generatePipeline);
    generatePass.setBindGroup(0, contourBindGroup);
    generatePass.dispatchWorkgroups(
      Math.ceil(this.gridWidth / 8),
      Math.ceil((this.gridHeight - 1) / 8)
    );
    generatePass.end();
  }

  /**
   * Run Chaikin smoothing passes on generated contour vertices
   * @param commandEncoder GPU command encoder
   * @param iterations Number of smoothing iterations (0-2)
   * @param vertexOffset Base vertex index for current level
   * @param maxVertices Max vertices for current level
   */
  runSmoothing(commandEncoder: GPUCommandEncoder, iterations: number, vertexOffset: number, maxVertices: number): void {
    if (iterations <= 0 || !this.computeReady) return;

    // Clear the smoothed buffer region to avoid stale data
    const byteOffset = vertexOffset * 16;
    const zeros = new Float32Array(maxVertices * 4);
    this.device.queue.writeBuffer(this.smoothedVertexBuffer, byteOffset, zeros);

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

    // If odd iterations, copy current level's result back to vertexBuffer
    if (iterations % 2 === 1) {
      const byteOffset = vertexOffset * 16;  // vec4f = 16 bytes
      const byteSize = maxVertices * 16;
      commandEncoder.copyBufferToBuffer(
        this.smoothedVertexBuffer, byteOffset,
        this.vertexBuffer, byteOffset,
        byteSize
      );
    }
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
   * Clear vertex buffer to remove stale geometry
   * Called before recomputing contours
   */
  clearVertexBuffer(): void {
    // Write zeros to the entire vertex buffer
    const maxSegmentsPerLevel = this.numCells * 2;
    const maxVerticesPerLevel = maxSegmentsPerLevel * 2;
    const bufferSize = maxVerticesPerLevel * this.currentLevelCount * 16;  // vec4f per vertex
    const zeros = new Float32Array(bufferSize / 4);
    this.device.queue.writeBuffer(this.vertexBuffer, 0, zeros);
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
    this.edgeToVertexBuffer?.destroy();
    this.smoothedVertexBuffer?.destroy();

    // Render buffers
    this.renderUniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
  }
}
