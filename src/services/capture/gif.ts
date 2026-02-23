/**
 * GIF encoding session
 *
 * Wraps gifenc library with palette strategies (fast, precise, grayscale).
 * The session owns all palette logic — callers just pass RGBA frames.
 */

import { GIFEncoder, applyPalette, quantize } from 'gifenc';

function buildGrayscalePalette(): number[][] {
  return Array.from({ length: 256 }, (_, i) => [i, i, i]);
}

/** Direct RGB->luminance indexing for grayscale palette */
function rgbaToLuminance(rgba: Uint8ClampedArray): Uint8Array {
  const n = rgba.length >> 2;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const off = i << 2;
    out[i] = (rgba[off]! * 77 + rgba[off + 1]! * 150 + rgba[off + 2]! * 29) >> 8;
  }
  return out;
}

/** Map RGBA pixels to nearest palette index by Euclidean distance in RGB */
function applyPaletteNearest(rgba: Uint8ClampedArray, palette: number[][]): Uint8Array {
  const n = rgba.length >> 2;
  const out = new Uint8Array(n);
  const pLen = palette.length;
  for (let i = 0; i < n; i++) {
    const off = i << 2;
    const r = rgba[off]!;
    const g = rgba[off + 1]!;
    const b = rgba[off + 2]!;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let j = 0; j < pLen; j++) {
      const pr = palette[j]![0]!;
      const pg = palette[j]![1]!;
      const pb = palette[j]![2]!;
      const dr = r - pr;
      const dg = g - pg;
      const db = b - pb;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = j;
      }
    }
    out[i] = bestIdx;
  }
  return out;
}

/** Extract a 256-color palette from a bitmap crop region */
export function extractPalette(
  bitmap: ImageBitmap,
  rect: { x: number; y: number; w: number; h: number },
  nativeDpr: boolean,
): number[][] {
  const dpr = window.devicePixelRatio;
  const srcX = Math.round(rect.x * dpr);
  const srcY = Math.round(rect.y * dpr);
  const srcW = Math.round(rect.w * dpr);
  const srcH = Math.round(rect.h * dpr);
  const outW = nativeDpr ? srcW : rect.w;
  const outH = nativeDpr ? srcH : rect.h;

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
  bitmap.close();

  return quantize(ctx.getImageData(0, 0, outW, outH).data, 256);
}

type PaletteMode = 'fast' | 'precise' | 'grayscale';

/** Create a GIF encoding session that manages palette strategy internally */
export function createGifSession(fps: number, paletteMode: PaletteMode, scenePalette: number[][] | null) {
  const encoder = new GIFEncoder();
  const delay = Math.round(1000 / fps);
  const palette = paletteMode === 'grayscale' ? buildGrayscalePalette() : scenePalette!;
  const indexFn = paletteMode === 'grayscale' ? rgbaToLuminance
    : paletteMode === 'precise' ? (rgba: Uint8ClampedArray) => applyPaletteNearest(rgba, palette)
    : (rgba: Uint8ClampedArray) => applyPalette(rgba, palette);

  return {
    addFrame(rgba: Uint8ClampedArray, w: number, h: number): void {
      encoder.writeFrame(indexFn(rgba), w, h, { palette, delay });
    },

    finish(): Blob {
      encoder.finish();
      return new Blob([encoder.bytes()], { type: 'image/gif' });
    },
  };
}
