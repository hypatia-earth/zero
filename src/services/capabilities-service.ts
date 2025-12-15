/**
 * CapabilitiesService - GPU capability detection
 *
 * Checks WebGPU features once during bootstrap, stores flags for later use.
 * Adapter is discarded after check - RenderService requests its own.
 */

import type { ConfigService } from './config-service';

const DEBUG = false;

export class CapabilitiesService {
  float32_filterable = false;
  maxBufferSizeMB = 0;

  constructor(private configService: ConfigService) {}

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

    DEBUG && console.log(`[Capabilities] float32_filterable: ${this.float32_filterable}`);
  }
}
