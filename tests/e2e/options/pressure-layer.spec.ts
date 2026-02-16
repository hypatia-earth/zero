/**
 * Pressure Layer E2E Tests
 *
 * Screenshot-based tests for pressure layer options.
 * Uses fixture with low (10°N, 10°E) and high (10°S, 10°W) pressure centers.
 * Split into two describe blocks to avoid contour worker state accumulation.
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

const FIXTURE = loadFixture('pressure-low-high');
const SOLID_WHITE = { mode: 'solid', colors: [[1, 1, 1, 0.85]] };

async function injectPressure(zero: ZeroTestAPI, page: Page) {
  await zero.SlotService.injectTestData('pressure', FIXTURE);
  await page.waitForTimeout(2500);
}

async function setupPressure(
  zero: ZeroTestAPI, page: Page,
  opts: { opacity?: number; spacing?: string; smoothing?: string } = {},
) {
  await zero.OptionsService.toggleLayer('pressure', true);
  await zero.OptionsService.setOpacity('pressure', opts.opacity ?? 1.0);
  await zero.OptionsService.set('pressure.spacing', opts.spacing ?? '4');
  await zero.OptionsService.set('pressure.smoothing', opts.smoothing ?? 'light');
  await zero.OptionsService.set('pressure.colors', SOLID_WHITE);
  await page.waitForTimeout(300);
  await injectPressure(zero, page);
}

// ============================================================
// Block 1: Enable, Smoothing, Opacity
// ============================================================

test.describe('pressure layer', () => {
  let page: Page;
  let zero: ZeroTestAPI;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    zero = createZeroAPI(page);
    await page.goto('https://localhost:5173/?layers=earth&lon=0&lat=0&alt=7000');
    await waitForAppReady(page);
    await setupTestEnv(page);
    await zero.UI.hide();
  });

  test.afterAll(async () => { await page.close(); });

  test.afterEach(async () => {
    await zero.OptionsService.toggleLayer('pressure', false);
    await page.waitForTimeout(500);
  });

  test('enabled - isobars visible', async () => {
    await setupPressure(zero, page);
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-enabled.png', { maxDiffPixelRatio: 0 });
  });

  test('smoothing none - jagged lines', async () => {
    await setupPressure(zero, page, { smoothing: 'none' });
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-smoothing-none.png', { maxDiffPixelRatio: 0 });
  });

  test('smoothing light - smooth lines', async () => {
    await setupPressure(zero, page, { smoothing: 'light' });
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-smoothing-light.png', { maxDiffPixelRatio: 0 });
  });

  test('opacity 0.3 - faint isobars', async () => {
    await setupPressure(zero, page, { opacity: 0.3 });
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-opacity-30.png', { maxDiffPixelRatio: 0 });
  });

  test('opacity 1.0 - full brightness', async () => {
    await setupPressure(zero, page, { opacity: 1.0 });
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-opacity-100.png', { maxDiffPixelRatio: 0 });
  });
});

// ============================================================
// Block 2: Spacing, Colors (fresh page to avoid state accumulation)
// ============================================================

test.describe('pressure layer - spacing & colors', () => {
  let page: Page;
  let zero: ZeroTestAPI;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    zero = createZeroAPI(page);
    await page.goto('https://localhost:5173/?layers=earth&lon=0&lat=0&alt=7000');
    await waitForAppReady(page);
    await setupTestEnv(page);
    await zero.UI.hide();
  });

  test.afterAll(async () => { await page.close(); });

  test.afterEach(async () => {
    await zero.OptionsService.toggleLayer('pressure', false);
    await page.waitForTimeout(500);
  });

  test('spacing 4 hPa - dense isobars', async () => {
    await setupPressure(zero, page, { spacing: '4' });
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-spacing-4.png', { maxDiffPixelRatio: 0 });
  });

  test('spacing 6 hPa', async () => {
    await setupPressure(zero, page, { spacing: '6' });
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-spacing-6.png', { maxDiffPixelRatio: 0 });
  });

  test('spacing 8 hPa', async () => {
    await setupPressure(zero, page, { spacing: '8' });
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-spacing-8.png', { maxDiffPixelRatio: 0 });
  });

  test('spacing 10 hPa - sparse isobars', async () => {
    await setupPressure(zero, page, { spacing: '10' });
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-spacing-10.png', { maxDiffPixelRatio: 0 });
  });

});

// ============================================================
// Block 3: Colors (fresh page — pressure contours stop rendering after ~5 inject cycles)
// ============================================================

test.describe('pressure layer - colors', () => {
  let page: Page;
  let zero: ZeroTestAPI;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    zero = createZeroAPI(page);
    await page.goto('https://localhost:5173/?layers=earth&lon=0&lat=0&alt=7000');
    await waitForAppReady(page);
    await setupTestEnv(page);
    await zero.UI.hide();
  });

  test.afterAll(async () => { await page.close(); });

  test.afterEach(async () => {
    await zero.OptionsService.toggleLayer('pressure', false);
    await page.waitForTimeout(500);
  });

  test('colors gradient - low/ref/high', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'light');
    await zero.OptionsService.set('pressure.colors', {
      mode: 'gradient',
      colors: [[0.28, 0.58, 1, 1], [1, 1, 1, 1], [1, 0.50, 0.35, 1]],
    });
    await page.waitForTimeout(300);
    await injectPressure(zero, page);
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-colors-gradient.png', { maxDiffPixelRatio: 0 });
  });

  test('colors normal - ref/other', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'light');
    await zero.OptionsService.set('pressure.colors', {
      mode: 'normal',
      colors: [[1, 1, 1, 1], [0.72, 0.50, 0.88, 0.85]],
    });
    await page.waitForTimeout(300);
    await injectPressure(zero, page);
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-colors-normal.png', { maxDiffPixelRatio: 0 });
  });

  test('colors debug - diagnostic view', async () => {
    await zero.OptionsService.toggleLayer('pressure', true);
    await zero.OptionsService.setOpacity('pressure', 1.0);
    await zero.OptionsService.set('pressure.spacing', '4');
    await zero.OptionsService.set('pressure.smoothing', 'light');
    await zero.OptionsService.set('pressure.colors', { mode: 'debug' });
    await page.waitForTimeout(300);
    await injectPressure(zero, page);
    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('pressure-colors-debug.png', { maxDiffPixelRatio: 0 });
  });
});
