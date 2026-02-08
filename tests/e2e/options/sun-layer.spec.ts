/**
 * Sun Layer E2E Tests
 *
 * Screenshot tests for sun sprite and atmospheric scattering.
 * Uses fixed date/position where sun is visible on screen.
 *
 * Update screenshots: npm run test:e2e -- sun-layer --update-snapshots
 */

import { test, expect, Page } from '@playwright/test';
import {
  createZeroAPI,
  waitForAppReady,
  setupTestEnv,
  type ZeroTestAPI,
  type Pixel,
} from '../helpers';

let page: Page;
let zero: ZeroTestAPI;

// Sun visible at: lat=23.5, lon=-22.6, alt=11266, date=2026-02-06T00:00Z
const SUN_VISIBLE_DATE = new Date('2026-02-06T00:00:00Z');
const SUN_VISIBLE_LAT = 23.5;
const SUN_VISIBLE_LON = -22.6;
const SUN_VISIBLE_ALT = 2.77;  // ~11266km in Earth radii

test.describe('sun layer', () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    zero = createZeroAPI(page);
    await page.goto('https://localhost:5173/?layers=earth&lon=0&lat=0&alt=5000');
    await waitForAppReady(page);
    await setupTestEnv(page);

    // Hide UI for clean screenshots
    await zero.UI.hide();

    // Enable earth layer as base
    await zero.OptionsService.toggleLayer('earth', true);
    await zero.OptionsService.setOpacity('earth', 1.0);
    await page.waitForTimeout(300);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test.afterEach(async () => {
    await zero.OptionsService.toggleLayer('sun', false);
    await page.waitForTimeout(100);
  });

  // ============================================================
  // Helper: Calculate brightness
  // ============================================================

  function brightness(pixel: Pixel): number {
    return (pixel.r + pixel.g + pixel.b) / 3;
  }

  // ============================================================
  // Screenshot Tests - Sun sprite and atmosphere
  // ============================================================

  test('enabled - sun sprite and scattering visible', async () => {
    await zero.StateService.setTime(SUN_VISIBLE_DATE);
    await zero.AuroraService.setCamera(SUN_VISIBLE_LAT, SUN_VISIBLE_LON, SUN_VISIBLE_ALT);
    await zero.OptionsService.toggleLayer('sun', true);
    await page.waitForTimeout(500);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('sun-enabled.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('disabled - no sun sprite', async () => {
    await zero.StateService.setTime(SUN_VISIBLE_DATE);
    await zero.AuroraService.setCamera(SUN_VISIBLE_LAT, SUN_VISIBLE_LON, SUN_VISIBLE_ALT);
    await zero.OptionsService.toggleLayer('sun', false);
    await page.waitForTimeout(500);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('sun-disabled.png', {
      maxDiffPixelRatio: 0,
    });
  });

  // ============================================================
  // Pixel Tests - Day/night shading
  // ============================================================

  test('day side brighter than night side', async () => {
    await zero.StateService.setTime(new Date('2024-06-21T12:00:00Z'));
    await zero.OptionsService.toggleLayer('sun', true);
    await page.waitForTimeout(500);

    // Day side: 10N, 10E - Nigeria (land, under sun at noon UTC)
    await zero.AuroraService.setCamera(10, 10, 1.5);
    await page.waitForTimeout(500);
    const dayPixel = await zero.Canvas.readCenterPixel();

    // Night side: 40N, 120W - California (opposite side, land)
    await zero.AuroraService.setCamera(40, -120, 1.5);
    await page.waitForTimeout(500);
    const nightPixel = await zero.Canvas.readCenterPixel();

    expect(brightness(dayPixel)).toBeGreaterThan(brightness(nightPixel));
  });

  test('noon vs midnight - brightness difference', async () => {
    await zero.OptionsService.toggleLayer('sun', true);

    // Noon at Nigeria (10N, 10E)
    await zero.StateService.setTime(new Date('2024-06-21T12:00:00Z'));
    await zero.AuroraService.setCamera(10, 10, 1.5);
    await page.waitForTimeout(500);
    const noonPixel = await zero.Canvas.readCenterPixel();

    // Midnight at same location
    await zero.StateService.setTime(new Date('2024-06-21T00:00:00Z'));
    await page.waitForTimeout(500);
    const midnightPixel = await zero.Canvas.readCenterPixel();

    expect(brightness(noonPixel)).toBeGreaterThan(brightness(midnightPixel));
  });
});
