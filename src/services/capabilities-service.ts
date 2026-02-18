/**
 * CapabilitiesService - Early GPU probe on main thread
 *
 * Validates WebGPU availability and checks float32-filterable support
 * (needed to decide LUT format before worker init). The worker requests
 * its own adapter/device — this probe exists to break the chicken-and-egg:
 * worker needs LUT assets at init, LUT format depends on float32 check.
 */

const DEBUG = true;

export class CapabilitiesService {
  float32Filterable = false;

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

    // Check buffer limits (minimum: 4 timeslots × 27 MB/slot = 108 MB)
    const minTimeslots = 4;  // Lowest option in gpu.timeslotsPerLayer enum
    const slotSizeMB = 27;   // ~26.4 MB per slot
    const minBufferMB = slotSizeMB * minTimeslots;
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

    this.float32Filterable = adapter.features.has('float32-filterable');

    const MB = (n: number) => `${Math.floor(n / 1024 / 1024)} MB`;

    // Try device.adapterInfo first (typed), fall back to adapter (runtime-only, blocked by Safari)
    let info: GPUAdapterInfo | undefined;
    const tempDevice = await adapter.requestDevice();
    info = tempDevice.adapterInfo;
    tempDevice.destroy();
    if (!info?.vendor) {
      info = (adapter as unknown as { adapterInfo?: GPUAdapterInfo }).adapterInfo;
    }

    const gpu = info?.vendor && info?.architecture
      ? `${info.vendor} ${info.architecture} — ${info.device || info.description || 'unknown'}`
      : 'unknown (adapter info blocked)';

    DEBUG && console.log(
      `[CAPS] ${gpu}\n` +
      `  buffer: ${MB(bufferLimit)}, storage: ${MB(storageLimit)}, ` +
      `storageBuffers: ${adapter.limits.maxStorageBuffersPerShaderStage}, ` +
      `textures: ${adapter.limits.maxTextureArrayLayers}\n` +
      `  features: float32=${this.float32Filterable}, timestamp=${adapter.features.has('timestamp-query')}\n` +
      `  cores: ${navigator.hardwareConcurrency}, screen: ${screen.width}x${screen.height} @${devicePixelRatio}x`
    );
  }
}
