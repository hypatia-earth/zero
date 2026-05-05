/**
 * Aurora telemetry — queryable any time via `getStats()`.
 *
 * GPU pass timings are populated via timestamp queries when available;
 * otherwise zero-filled. Memory totals reflect aurora-owned GPU resources.
 */

export interface AuroraMemoryStats {
  buffersBytes: number;
  texturesBytes: number;
}

export interface AuroraStats {
  cpuFrameMs: number;
  gpuPass1Ms: number;
  gpuComputeMs: number;
  gpuPass2Ms: number;
  gpuPass3Ms: number;
  drawCalls: number;
  memory: AuroraMemoryStats;
}
