/**
 * CapabilitiesService - GPU capability detection
 *
 * Checks WebGPU features once during bootstrap, stores flags for later use.
 * Adapter is discarded after check - RenderService requests its own.
 */

import type { ConfigService } from './config-service';

const DEBUG = true;

export class CapabilitiesService {
  float32_filterable = false;
  timestamp_query = false;
  msaa_8x = false;
  maxBufferSizeMB = 0;

  // For testing buffer allocation - set to small value (e.g., 50) to test without big downloads
  private readonly DEBUG_MAX_BUFFER_SIZE_MB: number | null = null;  // null = use real GPU limit

  constructor(private configService: ConfigService) {}

  /** Get effective max buffer size (respects debug override) */
  getEffectiveMaxBufferSize(): number {
    if (this.DEBUG_MAX_BUFFER_SIZE_MB !== null) {
      console.warn(`[Capabilities] DEBUG: maxBufferSize = ${this.DEBUG_MAX_BUFFER_SIZE_MB} MB`);
      return this.DEBUG_MAX_BUFFER_SIZE_MB;
    }
    return this.maxBufferSizeMB;
  }

  async init(): Promise<void> {
    if (!navigator.gpu) {
      throw new Error(
        'WebGPU not supported.\n\n' +
        'Requires: Chrome 113+, Edge 113+, Safari 18+, or Firefox 141+\n' +
        'More info: https://caniuse.com/webgpu'
      );
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error(
        'WebGPU: No adapter available.\n\n' +
        'Your browser supports WebGPU but no compatible GPU was found.\n' +
        'Try updating graphics drivers or using a different browser.'
      );
    }

    // Check buffer limits
    const gpuConfig = this.configService.getGpuConfig();
    const minBufferMB = gpuConfig.slotSizeMB * gpuConfig.minSlotsPerLayer;
    const minBufferBytes = minBufferMB * 1024 * 1024;
    const storageLimit = adapter.limits.maxStorageBufferBindingSize;
    const bufferLimit = adapter.limits.maxBufferSize;
    const effectiveLimit = Math.min(storageLimit, bufferLimit);

    if (effectiveLimit < minBufferBytes) {
      throw new Error(
        `GPU buffer too small.\n\n` +
        `Required: ${minBufferMB} MB, Available: ${(effectiveLimit / 1024 / 1024).toFixed(0)} MB\n` +
        `Your GPU cannot run weather visualization.`
      );
    }

    // Store for options UI to filter budget presets
    this.maxBufferSizeMB = Math.floor(effectiveLimit / 1024 / 1024);

    this.float32_filterable = adapter.features.has('float32-filterable');
    this.timestamp_query = adapter.features.has('timestamp-query');

    // MSAA 8x detection removed - WebGPU logs errors even with try/catch
    // Feature deferred anyway (see zero-feat-gpu-budget.md MSAA section)
    this.msaa_8x = false;

    DEBUG && console.log(`[Capabilities] float32_filterable: ${this.float32_filterable}, timestamp_query: ${this.timestamp_query}`);
  }
}
