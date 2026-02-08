/**
 * Earth Layer E2E Tests
 *
 * Pixel-based tests for earth basemap.
 * Verifies land vs water detection at known coordinates.
 *
 * Update screenshots: npm run test:e2e -- earth-layer --update-snapshots
 */

import { test, expect, Page } from '@playwright/test';
import {
  createZeroAPI,
  waitForAppReady,
  setupTestEnv,
  type ZeroTestAPI,
  type Pixel,
  BG,
} from '../helpers';

let page: Page;
let zero: ZeroTestAPI;

test.describe('earth layer', () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    zero = createZeroAPI(page);
    await page.goto('https://localhost:5173/?layers=earth&lon=0&lat=0&alt=2000');
    await waitForAppReady(page);
    await setupTestEnv(page);

    // Hide UI for clean tests
    await zero.UI.hide();

    // Enable only earth layer
    await zero.OptionsService.toggleLayer('earth', true);
    await zero.OptionsService.setOpacity('earth', 1.0);
    await page.waitForTimeout(300);
  });

  test.afterAll(async () => {
    await page.close();
  });

  // ============================================================
  // Helper: Check water vs land (grayscale basemap)
  // Water is brighter (~128), land is darker (~51)
  // ============================================================

  function isWater(pixel: Pixel): boolean {
    // Grayscale basemap: water is bright (>100)
    const brightness = (pixel.r + pixel.g + pixel.b) / 3;
    return brightness > 100;
  }

  function isLand(pixel: Pixel): boolean {
    // Grayscale basemap: land is dark (<80) but not background
    const brightness = (pixel.r + pixel.g + pixel.b) / 3;
    return brightness > BG[0] + 5 && brightness < 80;
  }

  // ============================================================
  // Land vs Water Detection
  // ============================================================

  test('0,0 is water (Gulf of Guinea)', async () => {
    await zero.AuroraService.setCamera(0, 0, 1.5);
    await page.waitForTimeout(500);

    const pixel = await zero.Canvas.readCenterPixel();
    expect(isWater(pixel)).toBe(true);
  });

  test('10N 10E is land (Nigeria)', async () => {
    await zero.AuroraService.setCamera(10, 10, 1.5);
    await page.waitForTimeout(500);

    const pixel = await zero.Canvas.readCenterPixel();
    expect(isLand(pixel)).toBe(true);
  });

  // ============================================================
  // Enable/Disable
  // ============================================================

  test('disabled - shows background', async () => {
    await zero.AuroraService.setCamera(10, 10, 1.5);
    await zero.OptionsService.toggleLayer('earth', false);
    await page.waitForTimeout(300);

    const pixel = await zero.Canvas.readCenterPixel();
    // Should be close to background color
    expect(pixel.r).toBeGreaterThanOrEqual(BG[0] - 5);
    expect(pixel.r).toBeLessThanOrEqual(BG[0] + 5);

    // Re-enable for next tests
    await zero.OptionsService.toggleLayer('earth', true);
    await page.waitForTimeout(300);
  });

  // ============================================================
  // Opacity Tests
  // ============================================================

  test('opacity 0.5 - blended with background', async () => {
    await zero.AuroraService.setCamera(10, 10, 1.5);
    await zero.OptionsService.setOpacity('earth', 1.0);
    await page.waitForTimeout(300);
    const fullPixel = await zero.Canvas.readCenterPixel();

    await zero.OptionsService.setOpacity('earth', 0.5);
    await page.waitForTimeout(300);
    const halfPixel = await zero.Canvas.readCenterPixel();

    // At 50% opacity, colors should be between full and background
    // The half-opacity pixel should be darker (closer to BG)
    expect(halfPixel.r).toBeLessThan(fullPixel.r);
    expect(halfPixel.g).toBeLessThan(fullPixel.g);

    // Restore
    await zero.OptionsService.setOpacity('earth', 1.0);
  });
});
