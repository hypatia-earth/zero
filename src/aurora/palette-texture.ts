/**
 * PaletteTexture - Shared GPU texture array for all palettes
 *
 * Creates a 256×N texture where each row is one palette.
 * Layers sample using their assigned palette index.
 */

import { PALETTES, PALETTE_IDS, type Palette, type PaletteId } from '../services/palette-service';

const PALETTE_WIDTH = 256;  // 256 colors per palette

export class PaletteTexture {
  readonly texture: GPUTexture;
  readonly sampler: GPUSampler;
  readonly paletteCount: number;

  // Map palette ID → row index
  private paletteIndexMap = new Map<PaletteId, number>();

  constructor(device: GPUDevice) {
    this.paletteCount = PALETTE_IDS.length;

    // Create 256×N texture (one row per palette)
    this.texture = device.createTexture({
      size: [PALETTE_WIDTH, this.paletteCount],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'palette-array',
    });

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Upload all palettes
    PALETTE_IDS.forEach((id, rowIndex) => {
      this.paletteIndexMap.set(id, rowIndex);
      const palette = PALETTES[id]!;
      const rgba = this.generateRGBA(palette);
      device.queue.writeTexture(
        { texture: this.texture, origin: [0, rowIndex, 0] },
        rgba as Uint8Array<ArrayBuffer>,  // WebGPU requires ArrayBuffer
        { bytesPerRow: PALETTE_WIDTH * 4 },
        { width: PALETTE_WIDTH, height: 1 }
      );
    });

  }

  /**
   * Get texture row index for a palette ID
   */
  getPaletteIndex(id: PaletteId): number {
    const index = this.paletteIndexMap.get(id);
    if (index === undefined) {
      console.warn(`[PaletteTexture] Unknown palette: ${id}, using 0`);
      return 0;
    }
    return index;
  }

  /**
   * Check if a palette uses stepped (discrete) colors
   */
  isStepped(id: PaletteId): boolean {
    const palette = PALETTES[id];
    return palette ? !palette.interpolate : false;
  }

  /**
   * Generate 256-entry RGBA from palette stops
   */
  private generateRGBA(palette: Palette): Uint8Array {
    const data = new Uint8Array(PALETTE_WIDTH * 4);
    const stops = palette.stops;

    if (stops.length === 0) {
      // Fallback: white
      for (let i = 0; i < PALETTE_WIDTH; i++) {
        data[i * 4 + 0] = 255;
        data[i * 4 + 1] = 255;
        data[i * 4 + 2] = 255;
        data[i * 4 + 3] = 255;
      }
      return data;
    }

    for (let i = 0; i < PALETTE_WIDTH; i++) {
      const t = i / (PALETTE_WIDTH - 1);  // 0 to 1
      const color = this.interpolateColor(palette, t);
      data[i * 4 + 0] = color[0];
      data[i * 4 + 1] = color[1];
      data[i * 4 + 2] = color[2];
      data[i * 4 + 3] = color[3];
    }

    return data;
  }

  /**
   * Interpolate color for normalized value t (0-1)
   */
  private interpolateColor(palette: Palette, t: number): [number, number, number, number] {
    const stops = palette.stops;

    // Find surrounding stops
    let lowerStop = stops[0]!;
    let upperStop = stops[stops.length - 1]!;

    for (let i = 0; i < stops.length - 1; i++) {
      const s1 = stops[i]!;
      const s2 = stops[i + 1]!;
      if (t >= s1.value && t <= s2.value) {
        lowerStop = s1;
        upperStop = s2;
        break;
      }
    }

    // Handle out-of-range
    if (t <= lowerStop.value) {
      return [...lowerStop.color, lowerStop.alpha];
    }
    if (t >= upperStop.value) {
      return [...upperStop.color, upperStop.alpha];
    }

    // Interpolate
    const range = upperStop.value - lowerStop.value;
    const frac = range > 0 ? (t - lowerStop.value) / range : 0;

    if (palette.interpolate) {
      const r = Math.round(lowerStop.color[0] + frac * (upperStop.color[0] - lowerStop.color[0]));
      const g = Math.round(lowerStop.color[1] + frac * (upperStop.color[1] - lowerStop.color[1]));
      const b = Math.round(lowerStop.color[2] + frac * (upperStop.color[2] - lowerStop.color[2]));
      const a = Math.round(lowerStop.alpha + frac * (upperStop.alpha - lowerStop.alpha));
      return [r, g, b, a];
    }

    // Stepped: use lower stop
    return [...lowerStop.color, lowerStop.alpha];
  }

  dispose(): void {
    this.texture.destroy();
  }
}
