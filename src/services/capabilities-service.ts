/**
 * CapabilitiesService - GPU capability detection
 *
 * Checks WebGPU features once during bootstrap, stores flags for later use.
 * Adapter is discarded after check - RenderService requests its own.
 */

const DEBUG = true;

export class CapabilitiesService {
  float32_filterable = false;

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

    this.float32_filterable = adapter.features.has('float32-filterable');

    DEBUG && console.log(`[Capabilities] float32_filterable: ${this.float32_filterable}`);
  }
}
