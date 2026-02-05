/**
 * E2E Test Helpers
 *
 * Two types of tests:
 *
 * 1. DETERMINISTIC PIXEL TESTS (testLayerPixels)
 *    - Inject known data via __zeroTestData before page load
 *    - Only the tested layer is enabled (no earth, no sun)
 *    - Background is the clear color rgb(22,22,22)
 *    - Assert exact RGB values (±1 for rounding)
 *    - Tests: data → palette → shader → GPU → pixel
 *
 * 2. BEHAVIORAL TESTS (toggle, persistence)
 *    - Use live data from server
 *    - May enable multiple layers (earth + temp)
 *    - Assert relative changes (pixel differs, option persists)
 *    - Tests: UI interaction → state → render effect
 */

import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '../fixtures');

/**
 * Background clear color from globe-renderer.ts line 694.
 * clearValue: { r: 0.086, g: 0.086, b: 0.086, a: 1 } → rgb(22,22,22)
 *
 * This is what's behind data layers when earth/sun are disabled.
 */
const BG = { r: 22, g: 22, b: 22 };

export type RGB = [number, number, number];

export interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Calculate expected pixel color for layer + opacity.
 *
 * Formula: final = layer * opacity + background * (1 - opacity)
 *
 * Only valid when earth/sun disabled (background = clear color).
 */
export function blendRgb(layer: RGB, opacity: number): RGB {
  return [
    Math.round(layer[0] * opacity + BG.r * (1 - opacity)),
    Math.round(layer[1] * opacity + BG.g * (1 - opacity)),
    Math.round(layer[2] * opacity + BG.b * (1 - opacity)),
  ];
}

/**
 * Test case for deterministic pixel tests.
 *
 * @param fixture - Name of .bin file in tests/fixtures/ (e.g., 'uniform-55')
 * @param palette - Palette name to apply (e.g., 'Classic Temperature')
 * @param baseRgb - Expected RGB at opacity 1.0 (from palette lookup)
 * @param opacities - Opacity values to test (default: [1.0])
 */
export interface LayerTestCase {
  fixture: string;
  palette: string;
  baseRgb: RGB;
  opacities?: number[];
}

/**
 * Load fixture as Float32Array from pre-generated .bin file.
 * Generate fixtures with: python tests/scripts/generate_test_bins.py
 */
export function loadFixture(name: string): Float32Array {
  const binPath = path.join(FIXTURES_DIR, `${name}.bin`);
  if (!fs.existsSync(binPath)) {
    throw new Error(`Fixture not found: ${binPath}. Run: python tests/scripts/generate_test_bins.py`);
  }
  const buffer = fs.readFileSync(binPath);
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}

/**
 * Generate deterministic pixel tests for a data layer.
 *
 * How it works:
 * 1. Load .bin fixture (uniform data, e.g., all 55°C)
 * 2. Inject into window.__zeroTestData BEFORE page load
 * 3. Navigate with ?layers=<layer> (only that layer enabled)
 * 4. SlotService intercepts upload and uses injected data
 * 5. Set palette and opacity via __hypatia API
 * 6. Read center pixel and assert exact RGB
 *
 * The expected RGB is calculated from baseRgb blended with
 * background color (22,22,22) at the given opacity.
 *
 * @example
 * testLayerPixels('temp', [
 *   { fixture: 'uniform-55', palette: 'Classic Temperature', baseRgb: [107, 28, 43] },
 *   { fixture: 'uniform-55', palette: 'Classic Temperature', baseRgb: [107, 28, 43], opacities: [0.5] },
 * ]);
 */
export function testLayerPixels(layer: string, cases: LayerTestCase[]): void {
  test.describe(`${layer} layer pixels`, () => {
    for (const { fixture, palette, baseRgb, opacities = [1.0] } of cases) {
      for (const opacity of opacities) {
        const expectedRgb = blendRgb(baseRgb, opacity);
        const testName = `${fixture} ${palette} @${opacity} → rgb(${expectedRgb.join(',')})`;

        test(testName, async ({ page }) => {
          // 1. Load fixture data
          const testData = loadFixture(fixture);

          // 2. Inject before navigation (SlotService checks this in constructor)
          await page.addInitScript(({ data, layer }) => {
            (window as unknown as { __zeroTestData: Record<string, Float32Array> }).__zeroTestData = {
              [layer]: new Float32Array(data)
            };
          }, { data: Array.from(testData), layer });

          // 3. Navigate with only this layer enabled
          const bootstrapPromise = page.waitForEvent('console', {
            predicate: msg => msg.text().includes('[ZERO] Bootstrap complete'),
            timeout: 60000
          });
          await page.goto(`https://localhost:5173/?layers=${layer}`);
          await bootstrapPromise;

          // 4. Configure palette and opacity
          await page.evaluate(({ layer, palette, opacity }) => {
            const h = (window as unknown as { __hypatia: { paletteService: { setPalette: (l: string, p: string) => void }; optionsService: { update: (fn: (d: Record<string, { opacity: number }>) => void) => void } } }).__hypatia;
            h.paletteService.setPalette(layer, palette);
            h.optionsService.update((d) => { d[layer].opacity = opacity; });
          }, { layer, palette, opacity });

          await page.waitForTimeout(500);

          // 5. Read and assert pixel
          const pixel = await readCenterPixel(page);

          expect(pixel.r).toBeGreaterThanOrEqual(expectedRgb[0] - 1);
          expect(pixel.r).toBeLessThanOrEqual(expectedRgb[0] + 1);
          expect(pixel.g).toBeGreaterThanOrEqual(expectedRgb[1] - 1);
          expect(pixel.g).toBeLessThanOrEqual(expectedRgb[1] + 1);
          expect(pixel.b).toBeGreaterThanOrEqual(expectedRgb[2] - 1);
          expect(pixel.b).toBeLessThanOrEqual(expectedRgb[2] + 1);

          // Pause for visual inspection in headed mode
          await page.waitForTimeout(1000);
        });
      }
    }
  });
}

/**
 * Read a pixel from the WebGPU canvas using Canvas 2D copy.
 * Coordinates are in canvas pixels (CSS pixels * devicePixelRatio).
 */
export async function readPixel(page: Page, x: number, y: number): Promise<Pixel> {
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
}

/**
 * Read pixel at center of canvas.
 */
export async function readCenterPixel(page: Page): Promise<Pixel> {
  const { width, height } = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    return { width: canvas.width, height: canvas.height };
  });
  return readPixel(page, Math.floor(width / 2), Math.floor(height / 2));
}

/**
 * Wait for app to be fully loaded (bootstrap complete).
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    return typeof (window as any).__hypatia !== 'undefined';
  }, { timeout: 30000 });
}

/**
 * Wait for a specific layer to have data ready.
 */
export async function waitForLayerReady(page: Page, layer: string): Promise<void> {
  await page.waitForFunction((layer) => {
    const hypatia = (window as any).__hypatia;
    return hypatia?.slotService?.readyLayers?.includes(layer);
  }, layer, { timeout: 30000 });
}

/**
 * Get fixture path for a synthetic OM file.
 */
export function getFixturePath(filename: string): string {
  return path.join(__dirname, '..', 'fixtures', filename);
}

/**
 * Read fixture file as buffer.
 */
export function readFixture(filename: string): Buffer {
  return fs.readFileSync(getFixturePath(filename));
}

/**
 * Set up route to intercept OM file requests and serve synthetic fixture.
 */
export async function interceptOMRequests(page: Page, fixture: string): Promise<void> {
  const fixtureData = readFixture(fixture);
  await page.route('**/*.om', async (route) => {
    await route.fulfill({
      body: fixtureData,
      contentType: 'application/octet-stream',
    });
  });
}
