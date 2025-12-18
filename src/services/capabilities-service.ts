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
    this.timestamp_query = adapter.features.has('timestamp-query');

    // Test MSAA 8x support (requires temporary device)
    try {
      const testDevice = await adapter.requestDevice();
      const testTexture = testDevice.createTexture({
        size: [1, 1],
        format: 'bgra8unorm',
        sampleCount: 8,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      testTexture.destroy();
      testDevice.destroy();
      this.msaa_8x = true;
    } catch {
      this.msaa_8x = false;
    }

    DEBUG && console.log(`[Capabilities] float32_filterable: ${this.float32_filterable}, timestamp_query: ${this.timestamp_query}, msaa_8x: ${this.msaa_8x}`);
  }
}
