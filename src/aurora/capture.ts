/**
 * Capture utilities — GPU texture creation, pixel readback, and deferred frame capture.
 */

import type { GlobeRenderer } from './globe-renderer';

/** Create an offscreen capture texture (RENDER_ATTACHMENT + COPY_SRC) */
export function createCaptureTexture(
  device: GPUDevice, width: number, height: number, format: GPUTextureFormat,
): GPUTexture {
  return device.createTexture({
    size: [width, height],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
}

/** Read pixels directly from GPU texture — bypasses canvas compositor */
export async function readbackFrame(
  device: GPUDevice, texture: GPUTexture, format: GPUTextureFormat,
): Promise<ImageBitmap> {
  const { width, height } = texture;
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;

  const staging = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow }, { width, height });
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(staging.getMappedRange());

  const rowBytes = width * 4;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const swapRB = format === 'bgra8unorm';

  for (let y = 0; y < height; y++) {
    const src = y * bytesPerRow;
    const dst = y * rowBytes;
    if (swapRB) {
      for (let x = 0; x < width; x++) {
        const si = src + x * 4;
        const di = dst + x * 4;
        rgba[di] = mapped[si + 2]!;
        rgba[di + 1] = mapped[si + 1]!;
        rgba[di + 2] = mapped[si]!;
        rgba[di + 3] = mapped[si + 3]!;
      }
    } else {
      rgba.set(mapped.subarray(src, src + rowBytes), dst);
    }
  }

  staging.unmap();
  staging.destroy();

  return createImageBitmap(new ImageData(rgba, width, height));
}

/** Factory for deferred frame capture (set flag → flush after render) */
export function createCaptureHandler(
  getRenderer: () => GlobeRenderer | null,
): {
  handleCaptureFrame: () => void;
  flushCaptureFrame: () => Promise<void>;
} {
  let pending = false;

  return {
    handleCaptureFrame() {
      pending = true;
    },
    async flushCaptureFrame() {
      const renderer = getRenderer();
      if (!pending || !renderer) return;
      pending = false;
      const bitmap = await renderer.readbackFrame();
      (self as unknown as Worker).postMessage(
        { type: 'exportFrame', bitmap },
        [bitmap],
      );
    },
  };
}
