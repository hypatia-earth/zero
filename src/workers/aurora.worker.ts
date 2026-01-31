/**
 * Aurora Worker - GPU rendering in dedicated worker thread
 *
 * Handles all WebGPU operations off the main thread to prevent jank:
 * - OffscreenCanvas rendering
 * - Buffer uploads (writeBuffer)
 * - Render loop
 *
 * Main thread sends camera/options/time updates, worker builds uniforms and renders.
 */

// Message types
export type AuroraRequest =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number }
  | { type: 'render' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'cleanup' };

export type AuroraResponse =
  | { type: 'ready' }
  | { type: 'frameComplete'; timing?: { frame: number } }
  | { type: 'error'; message: string; fatal: boolean };

// Worker state
let device: GPUDevice | null = null;
let context: GPUCanvasContext | null = null;
let canvas: OffscreenCanvas | null = null;
let format: GPUTextureFormat;

self.onmessage = async (e: MessageEvent<AuroraRequest>) => {
  const { type } = e.data;

  try {
    if (type === 'init') {
      canvas = e.data.canvas;
      canvas.width = e.data.width;
      canvas.height = e.data.height;

      // Request WebGPU adapter
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        self.postMessage({
          type: 'error',
          message: 'No WebGPU adapter available',
          fatal: true,
        } satisfies AuroraResponse);
        return;
      }

      // Request device
      device = await adapter.requestDevice();
      device.lost.then((info) => {
        self.postMessage({
          type: 'error',
          message: `GPU device lost: ${info.reason} - ${info.message}`,
          fatal: true,
        } satisfies AuroraResponse);
      });

      // Configure canvas context
      context = canvas.getContext('webgpu');
      if (!context) {
        self.postMessage({
          type: 'error',
          message: 'Failed to get WebGPU context',
          fatal: true,
        } satisfies AuroraResponse);
        return;
      }

      format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format });

      self.postMessage({ type: 'ready' } satisfies AuroraResponse);
    }

    if (type === 'render') {
      if (!device || !context) {
        self.postMessage({
          type: 'error',
          message: 'Worker not initialized',
          fatal: false,
        } satisfies AuroraResponse);
        return;
      }

      const t0 = performance.now();

      // Render solid color (Phase 1 test)
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.1, g: 0.0, b: 0.2, a: 1.0 },  // Dark purple
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.end();
      device.queue.submit([encoder.finish()]);

      const frameTime = performance.now() - t0;
      self.postMessage({
        type: 'frameComplete',
        timing: { frame: frameTime },
      } satisfies AuroraResponse);
    }

    if (type === 'resize') {
      if (canvas) {
        canvas.width = e.data.width;
        canvas.height = e.data.height;
      }
    }

    if (type === 'cleanup') {
      context?.unconfigure();
      device?.destroy();
      device = null;
      context = null;
      canvas = null;
    }

  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      fatal: false,
    } satisfies AuroraResponse);
  }
};
