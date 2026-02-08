/**
 * E2E Test Helpers
 *
 * Provides typed ZeroTestAPI for clean test code:
 *   const zero = createZeroAPI(page);
 *   await zero.SlotService.injectTestData('temp', fixture);
 *   await zero.OptionsService.toggleLayer('temp', true);
 *   const pixel = await zero.Canvas.readCenterPixel();
 */

import { expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '../fixtures');

// ============================================================
// Types
// ============================================================

export type RGB = [number, number, number];

export interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Background clear color from globe-renderer.ts.
 * clearValue: { r: 0.086, g: 0.086, b: 0.086, a: 1 } → rgb(22,22,22)
 */
export const BG: RGB = [22, 22, 22];

// ============================================================
// Zero Test API
// ============================================================

export interface ZeroTestAPI {
  SlotService: {
    /** Inject test data. For multi-slab layers (wind), pass array of Float32Arrays. */
    injectTestData(layer: string, data: Float32Array | Float32Array[]): Promise<void>;
  };
  OptionsService: {
    toggleLayer(layer: string, enabled: boolean): Promise<void>;
    setOpacity(layer: string, opacity: number): Promise<void>;
    set(path: string, value: unknown): Promise<void>;
    setMany(changes: Record<string, unknown>): Promise<void>;
    get(path: string): Promise<unknown>;
    getAll(): Promise<Record<string, unknown>>;
  };
  PaletteService: {
    setPalette(layer: string, palette: string): Promise<void>;
  };
  StateService: {
    setTime(date: Date): Promise<void>;
  };
  AuroraService: {
    setCamera(lon: number, lat: number, altitude: number): Promise<void>;
    triggerPressureRegrid(): Promise<void>;
  };
  Canvas: {
    readPixel(x: number, y: number): Promise<Pixel>;
    readCenterPixel(): Promise<Pixel>;
  };
  Schema: {
    getMutations(skipPaths: string[]): Promise<Record<string, unknown>>;
  };
  UI: {
    hide(): Promise<void>;
    show(): Promise<void>;
  };
}

export function createZeroAPI(page: Page): ZeroTestAPI {
  return {
    SlotService: {
      async injectTestData(layer: string, data: Float32Array | Float32Array[]): Promise<void> {
        const slabs = Array.isArray(data) ? data : [data];
        const base64Slabs = slabs.map(slab => {
          const buffer = Buffer.from(slab.buffer);
          return buffer.toString('base64');
        });
        await page.evaluate(({ layer, b64Slabs }) => {
          const floatSlabs = b64Slabs.map((b64: string) => {
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            return new Float32Array(bytes.buffer);
          });
          const data = floatSlabs.length === 1 ? floatSlabs[0] : floatSlabs;
          (window as any).__hypatia.slotService.injectTestData(layer, data);
        }, { layer, b64Slabs: base64Slabs });
      },
    },

    OptionsService: {
      async toggleLayer(layer: string, enabled: boolean): Promise<void> {
        await page.evaluate(({ layer, enabled }) => {
          (window as any).__hypatia.optionsService.update((d: any) => {
            d[layer].enabled = enabled;
          });
        }, { layer, enabled });
        await page.waitForTimeout(100);
      },

      async setOpacity(layer: string, opacity: number): Promise<void> {
        await page.evaluate(({ layer, opacity }) => {
          (window as any).__hypatia.optionsService.update((d: any) => {
            d[layer].opacity = opacity;
          });
        }, { layer, opacity });
        await page.waitForTimeout(100);
      },

      async set(optionPath: string, value: unknown): Promise<void> {
        await page.evaluate(({ path, value }) => {
          const parts = path.split('.');
          (window as any).__hypatia.optionsService.update((d: any) => {
            let obj = d;
            for (let i = 0; i < parts.length - 1; i++) {
              obj = obj[parts[i]];
            }
            obj[parts[parts.length - 1]] = value;
          });
        }, { path: optionPath, value });
        await page.waitForTimeout(100);
      },

      async get(optionPath: string): Promise<unknown> {
        return page.evaluate((path) => {
          const opts = (window as any).__hypatia.optionsService.options.value;
          return path.split('.').reduce((obj: any, key: string) => obj?.[key], opts);
        }, optionPath);
      },

      async getAll(): Promise<Record<string, unknown>> {
        return page.evaluate(() =>
          JSON.parse(JSON.stringify((window as any).__hypatia.optionsService.options.value))
        );
      },

      async setMany(changes: Record<string, unknown>): Promise<void> {
        await page.evaluate((c) => {
          (window as any).__hypatia.optionsService.update((draft: any) => {
            for (const [path, value] of Object.entries(c)) {
              const parts = path.split('.');
              let obj = draft;
              for (let i = 0; i < parts.length - 1; i++) {
                obj = obj[parts[i]];
              }
              obj[parts[parts.length - 1]] = value;
            }
          });
        }, changes);
        await page.waitForTimeout(100);
      },
    },

    PaletteService: {
      async setPalette(layer: string, palette: string): Promise<void> {
        await page.evaluate(({ layer, palette }) => {
          (window as any).__hypatia.paletteService.setPalette(layer, palette);
        }, { layer, palette });
        await page.waitForTimeout(100);
      },
    },

    StateService: {
      async setTime(date: Date): Promise<void> {
        await page.evaluate((timestamp) => {
          (window as any).__hypatia.stateService.setTime(new Date(timestamp));
        }, date.getTime());
        await page.waitForTimeout(100);
      },
    },

    AuroraService: {
      async setCamera(lon: number, lat: number, altitude: number): Promise<void> {
        await page.evaluate(({ lon, lat, altitude }) => {
          const camera = (window as any).__hypatia.auroraService.getCamera();
          camera.setPosition(lon, lat, altitude);
        }, { lon, lat, altitude });
        await page.waitForTimeout(200);
      },
      async triggerPressureRegrid(): Promise<void> {
        await page.evaluate(() => {
          (window as any).__hypatia.auroraService.triggerPressureRegrid(0);
        });
        await page.waitForTimeout(100);
      },
    },

    Canvas: {
      async readPixel(x: number, y: number): Promise<Pixel> {
        return page.evaluate(({ x, y }) => {
          const canvas = document.querySelector('canvas')!;
          const temp = document.createElement('canvas');
          temp.width = canvas.width;
          temp.height = canvas.height;
          const ctx = temp.getContext('2d')!;
          ctx.drawImage(canvas, 0, 0);
          const p = ctx.getImageData(x, y, 1, 1).data;
          return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3]! };
        }, { x, y });
      },

      async readCenterPixel(): Promise<Pixel> {
        const { width, height } = await page.evaluate(() => {
          const canvas = document.querySelector('canvas')!;
          return { width: canvas.width, height: canvas.height };
        });
        return this.readPixel(Math.floor(width / 2), Math.floor(height / 2));
      },
    },

    Schema: {
      async getMutations(skipPaths: string[]): Promise<Record<string, unknown>> {
        return page.evaluate((skip) => {
          const { extractOptionsMeta, defaultOptions } = (window as any).__hypatia.schema;
          const flatOptions = extractOptionsMeta();
          const changes: Record<string, unknown> = {};

          for (const opt of flatOptions) {
            if (skip.includes(opt.path)) continue;
            if (opt.meta.hidden) continue;

            const defaultVal = opt.path.split('.').reduce(
              (obj: any, key: string) => obj?.[key],
              defaultOptions
            );

            switch (opt.meta.control) {
              case 'toggle':
              case 'layer-toggle':
                changes[opt.path] = !defaultVal;
                break;

              case 'slider': {
                const { min, max } = opt.meta;
                const mid = (min + max) / 2;
                const quarter = min + (max - min) * 0.25;
                changes[opt.path] = Math.abs(defaultVal - mid) > 0.01 ? mid : quarter;
                break;
              }

              case 'select':
              case 'radio': {
                const opts = opt.meta.options;
                const alt = opts.find((o: any) => o.value !== defaultVal);
                if (alt) changes[opt.path] = alt.value;
                break;
              }
            }
          }

          return changes;
        }, skipPaths);
      },
    },

    UI: {
      async hide(): Promise<void> {
        await page.evaluate(() => {
          const el = document.querySelector('.ui-container') as HTMLElement;
          if (el) el.style.display = 'none';
        });
      },
      async show(): Promise<void> {
        await page.evaluate(() => {
          const el = document.querySelector('.ui-container') as HTMLElement;
          if (el) el.style.display = '';
        });
      },
    },
  };
}

// ============================================================
// Fixtures
// ============================================================

/**
 * Load fixture as Float32Array from .bin file.
 * Generate fixtures: python tests/scripts/generate_test_bins.py
 */
export function loadFixture(name: string): Float32Array {
  const binPath = path.join(FIXTURES_DIR, `${name}.bin`);
  if (!fs.existsSync(binPath)) {
    throw new Error(`Fixture not found: ${binPath}. Run: python tests/scripts/generate_test_bins.py`);
  }
  const buffer = fs.readFileSync(binPath);
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}

// ============================================================
// Page Setup
// ============================================================

/**
 * Wait for app bootstrap to complete.
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    return typeof (window as any).__hypatia !== 'undefined';
  }, { timeout: 60000 });

  // Close bootstrap modal - click Start if visible, otherwise wait for auto-close
  const startButton = page.locator('.dialog.bootstrap button.btn-primary');
  if (await startButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await startButton.click();
  }
  await page.waitForSelector('.dialog.bootstrap', { state: 'hidden', timeout: 5000 }).catch(() => {});
}

/**
 * Setup clean test environment.
 * Disables all layers for clean background.
 */
export async function setupTestEnv(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__hypatia.optionsService.update((d: any) => {
      d.earth.enabled = false;
      d.sun.enabled = false;
      d.grid.enabled = false;
      d.temp.enabled = false;
      d.rain.enabled = false;
      d.clouds.enabled = false;
      d.humidity.enabled = false;
      d.wind.enabled = false;
      d.pressure.enabled = false;
    });
  });
  await page.waitForTimeout(100);
}

// ============================================================
// Assertions
// ============================================================

/**
 * Calculate expected pixel color for layer + opacity.
 * Formula: final = layer * opacity + background * (1 - opacity)
 */
export function blendRgb(layer: RGB, opacity: number): RGB {
  return [
    Math.round(layer[0] * opacity + BG[0] * (1 - opacity)),
    Math.round(layer[1] * opacity + BG[1] * (1 - opacity)),
    Math.round(layer[2] * opacity + BG[2] * (1 - opacity)),
  ];
}

/**
 * Assert pixel RGB matches expected within tolerance.
 */
export function expectRgb(pixel: Pixel, expected: RGB, tolerance = 1): void {
  expect(pixel.r).toBeGreaterThanOrEqual(expected[0] - tolerance);
  expect(pixel.r).toBeLessThanOrEqual(expected[0] + tolerance);
  expect(pixel.g).toBeGreaterThanOrEqual(expected[1] - tolerance);
  expect(pixel.g).toBeLessThanOrEqual(expected[1] + tolerance);
  expect(pixel.b).toBeGreaterThanOrEqual(expected[2] - tolerance);
  expect(pixel.b).toBeLessThanOrEqual(expected[2] + tolerance);
}

/**
 * Assert pixel is background color (no layer rendered).
 * Uses tolerance of 2 due to minor GPU/antialiasing variations.
 */
export function expectBackground(pixel: Pixel): void {
  expectRgb(pixel, BG, 2);
}

/**
 * Assert pixel is NOT background color (something rendered).
 */
export function expectNotBackground(pixel: Pixel): void {
  const isBackground = pixel.r === BG[0] && pixel.g === BG[1] && pixel.b === BG[2];
  expect(isBackground).toBe(false);
}
