export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' }): number[][];
export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
export function nearestColorIndex(palette: number[][], pixel: [number, number, number]): number;
export function snapColorsToPalette(palette: number[][], knownColors: number[][], threshold?: number): void;
export class GIFEncoder {
  constructor(opts?: { auto?: boolean });
  writeFrame(index: Uint8Array, width: number, height: number, opts?: {
    palette?: number[][];
    delay?: number;
    dispose?: number;
    transparent?: boolean;
    transparentIndex?: number;
  }): void;
  finish(): void;
  bytes(): Uint8Array;
  bytesView(): Uint8Array;
  buffer: ArrayBuffer;
  stream: ReadableStream<Uint8Array>;
}
