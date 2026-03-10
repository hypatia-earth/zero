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
  pxScale?: number,
): number[][] {
  const scale = pxScale ?? window.devicePixelRatio;
  let srcX = Math.round(rect.x * scale);
  let srcY = Math.round(rect.y * scale);
  let srcW = Math.round(rect.w * scale);
  let srcH = Math.round(rect.h * scale);

  // Clamp to bitmap bounds — shouldn't happen (rect is viewport-constrained),
  // but guards against stale bitmap after orientation change on iPad Safari
  srcX = Math.min(srcX, bitmap.width);
  srcY = Math.min(srcY, bitmap.height);
  srcW = Math.min(srcW, bitmap.width - srcX);
  srcH = Math.min(srcH, bitmap.height - srcY);

  const outW = nativeDpr ? srcW : Math.round(srcW / scale);
  const outH = nativeDpr ? srcH : Math.round(srcH / scale);

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
  bitmap.close();

  return quantize(ctx.getImageData(0, 0, outW, outH).data, 256);
}

type PaletteMode = 'fast' | 'precise' | 'grayscale';

/** Build a GIF comment extension block (0x21 0xFE) from text */
function buildCommentBlock(text: string): Uint8Array {
  const data = new TextEncoder().encode(text);
  const bytes: number[] = [0x21, 0xFE];
  for (let i = 0; i < data.length; i += 255) {
    const end = Math.min(i + 255, data.length);
    bytes.push(end - i);
    for (let j = i; j < end; j++) bytes.push(data[j]!);
  }
  bytes.push(0x00);
  return new Uint8Array(bytes);
}

/** Create a GIF encoding session that manages palette strategy internally */
export function createGifSession(fps: number, paletteMode: PaletteMode, scenePalette: number[][] | null, comment: string) {
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
      const gif = encoder.bytes();
      const block = buildCommentBlock(comment);
      // Insert comment after header (6B) + LSD (7B) + global color table
      const packed = gif[10]!;
      const gctBytes = (packed >> 7) & 1 ? 3 * (2 ** ((packed & 0x07) + 1)) : 0;
      const insertAt = 13 + gctBytes;
      const result = new Uint8Array(gif.length + block.length);
      result.set(gif.subarray(0, insertAt));
      result.set(block, insertAt);
      result.set(gif.subarray(insertAt), insertAt + block.length);
      return new Blob([result], { type: 'image/gif' });
    },
  };
}
