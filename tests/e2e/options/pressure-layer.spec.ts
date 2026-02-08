/**
 * Pressure Layer E2E Tests
 *
 * Screenshot-based tests for pressure layer options.
 * Uses fixture with low (10°N, 10°E) and high (10°S, 10°W) pressure centers.
 *
 * Generate fixtures: python tests/scripts/generate_pressure_fixtures.py
 * Update screenshots: npm run test:e2e -- pressure-layer --update-snapshots
 */

import { test, expect, Page } from '@playwright/test';
import {
  createZeroAPI,
  loadFixture,
  waitForAppReady,
  setupTestEnv,
  type ZeroTestAPI,
} from '../helpers';

// Fixture data: low at 10N/10E, high at 10S/10W
const FIXTURE = loadFixture('pressure-low-high');

let page: Page;
let zero: ZeroTestAPI;

test.describe('pressure layer', () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    zero = createZeroAPI(page);
    await page.goto('https://localhost:5173/?layers=earth&lon=0&lat=0&alt=7000');
    await waitForAppReady(page);
    await setupTestEnv(page);

    // Hide UI for clean screenshots
    await zero.UI.hide();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test.afterEach(async () => {
    await zero.OptionsService.toggleLayer('pressure', false);
    await page.waitForTimeout(100);
  });

  /** Inject pressure fixture (regrid triggered automatically by SlotService) */
  async function injectPressure() {
    await zero.SlotService.injectTestData('pressure', FIXTURE);
    await page.waitForTimeout(1500);  // Wait for upload, regrid, and contour computation
  }

  // ============================================================
  // Enable/Disable
  // ============================================================

  test('enabled - isobars visible', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'laplacian');
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-enabled.png', {
      maxDiffPixelRatio: 0,
    });
  });

  // ============================================================
  // Opacity Tests
  // ============================================================

  test('opacity 0.3 - faint isobars', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 0.3);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'laplacian');
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-opacity-30.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('opacity 1.0 - full brightness', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'laplacian');
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-opacity-100.png', {
      maxDiffPixelRatio: 0,
    });
  });

  // ============================================================
  // Spacing Tests
  // ============================================================

  test('spacing 4 hPa - dense isobars', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'laplacian');
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-spacing-4.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('spacing 6 hPa', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '6');
    await zero.OptionsService.set('pressure.smoothing', 'laplacian');
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-spacing-6.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('spacing 8 hPa', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '8');
    await zero.OptionsService.set('pressure.smoothing', 'laplacian');
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-spacing-8.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('spacing 10 hPa - sparse isobars', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '10');
    await zero.OptionsService.set('pressure.smoothing', 'laplacian');
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-spacing-10.png', {
      maxDiffPixelRatio: 0,
    });
  });

  // ============================================================
  // Smoothing Tests
  // ============================================================

  test('smoothing none - jagged lines', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'none');
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-smoothing-none.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('smoothing laplacian - smooth lines', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'laplacian');
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-smoothing-laplacian.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('smoothing chaikin - subdivided corners', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'chaikin');
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-smoothing-chaikin.png', {
      maxDiffPixelRatio: 0,
    });
  });

  // ============================================================
  // Color Tests
  // ============================================================

  test('colors gradient - low/ref/high', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'laplacian');
    await zero.OptionsService.set('pressure.colors', {
      mode: 'gradient',
      colors: [[0.28, 0.58, 1, 1], [1, 1, 1, 1], [1, 0.50, 0.35, 1]],
    });
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-colors-gradient.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('colors normal - ref/other', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'laplacian');
    await zero.OptionsService.set('pressure.colors', {
      mode: 'normal',
      colors: [[1, 1, 1, 1], [0.72, 0.50, 0.88, 0.85]],
    });
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-colors-normal.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('colors debug - diagnostic view', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'laplacian');
    await zero.OptionsService.set('pressure.colors', { mode: 'debug' });
    await page.waitForTimeout(300);
    await injectPressure();

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-colors-debug.png', {
      maxDiffPixelRatio: 0,
    });
  });
});
