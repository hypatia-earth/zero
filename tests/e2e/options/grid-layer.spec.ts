/**
 * Grid Layer E2E Tests
 *
 * Screenshot-based tests for grid layer options.
 * No fixture needed - decoration layer only.
 *
 * Update screenshots: npm run test:e2e -- grid-layer --update-snapshots
 */

import { test, expect, Page } from '@playwright/test';
import {
  createZeroAPI,
  waitForAppReady,
  setupTestEnv,
  type ZeroTestAPI,
} from '../helpers';

let page: Page;
let zero: ZeroTestAPI;

test.describe('grid layer', () => {
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
    await zero.OptionsService.toggleLayer('grid', false);
    await page.waitForTimeout(100);
  });

  // ============================================================
  // Enable/Disable
  // ============================================================

  test('enabled - grid visible', async () => {
    await zero.OptionsService.toggleLayer('grid', true);
    await zero.OptionsService.setOpacity('grid', 1.0);
    await zero.OptionsService.set('grid.fontSize', 12);
    await zero.OptionsService.set('grid.lineWidth', 2);
    await page.waitForTimeout(300);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('grid-enabled.png', {
      maxDiffPixelRatio: 0,
    });
  });

  // ============================================================
  // Opacity Tests
  // ============================================================

  test('opacity 0.3 - faint grid', async () => {
    await zero.OptionsService.toggleLayer('grid', true);
    await zero.OptionsService.setOpacity('grid', 0.3);
    await zero.OptionsService.set('grid.fontSize', 12);
    await zero.OptionsService.set('grid.lineWidth', 2);
    await page.waitForTimeout(300);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('grid-opacity-30.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('opacity 1.0 - full brightness', async () => {
    await zero.OptionsService.toggleLayer('grid', true);
    await zero.OptionsService.setOpacity('grid', 1.0);
    await zero.OptionsService.set('grid.fontSize', 12);
    await zero.OptionsService.set('grid.lineWidth', 2);
    await page.waitForTimeout(300);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('grid-opacity-100.png', {
      maxDiffPixelRatio: 0,
    });
  });

  // ============================================================
  // Font Size Tests
  // ============================================================

  test('fontSize 8 - small labels', async () => {
    await zero.OptionsService.toggleLayer('grid', true);
    await zero.OptionsService.setOpacity('grid', 1.0);
    await zero.OptionsService.set('grid.fontSize', 8);
    await zero.OptionsService.set('grid.lineWidth', 2);
    await page.waitForTimeout(300);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('grid-fontsize-8.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('fontSize 16 - large labels', async () => {
    await zero.OptionsService.toggleLayer('grid', true);
    await zero.OptionsService.setOpacity('grid', 1.0);
    await zero.OptionsService.set('grid.fontSize', 16);
    await zero.OptionsService.set('grid.lineWidth', 2);
    await page.waitForTimeout(300);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('grid-fontsize-16.png', {
      maxDiffPixelRatio: 0,
    });
  });

  // ============================================================
  // Line Width Tests
  // ============================================================

  test('lineWidth 1 - thin lines', async () => {
    await zero.OptionsService.toggleLayer('grid', true);
    await zero.OptionsService.setOpacity('grid', 1.0);
    await zero.OptionsService.set('grid.fontSize', 12);
    await zero.OptionsService.set('grid.lineWidth', 1);
    await page.waitForTimeout(300);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('grid-linewidth-1.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('lineWidth 3 - medium lines', async () => {
    await zero.OptionsService.toggleLayer('grid', true);
    await zero.OptionsService.setOpacity('grid', 1.0);
    await zero.OptionsService.set('grid.fontSize', 12);
    await zero.OptionsService.set('grid.lineWidth', 3);
    await page.waitForTimeout(300);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('grid-linewidth-3.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('lineWidth 5 - thick lines', async () => {
    await zero.OptionsService.toggleLayer('grid', true);
    await zero.OptionsService.setOpacity('grid', 1.0);
    await zero.OptionsService.set('grid.fontSize', 12);
    await zero.OptionsService.set('grid.lineWidth', 5);
    await page.waitForTimeout(300);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('grid-linewidth-5.png', {
      maxDiffPixelRatio: 0,
    });
  });

  // ============================================================
  // LoD (Level of Detail) Tests - different zoom levels
  // Grid spacing changes based on globe radius in pixels
  // ============================================================

  test('lod 0 - zoomed out (30° spacing)', async () => {
    await zero.OptionsService.toggleLayer('grid', true);
    await zero.OptionsService.setOpacity('grid', 1.0);
    await zero.OptionsService.set('grid.lineWidth', 2);
    await zero.AuroraService.setCamera(0, 0, 6.0);  // Far out
    await page.waitForTimeout(2000);  // Wait for animation to settle

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('grid-lod-0-far.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('lod 2 - medium zoom (15° spacing)', async () => {
    await zero.OptionsService.toggleLayer('grid', true);
    await zero.OptionsService.setOpacity('grid', 1.0);
    await zero.OptionsService.set('grid.lineWidth', 2);
    await zero.AuroraService.setCamera(0, 0, 2.5);  // Medium
    await page.waitForTimeout(2000);  // Wait for animation to settle

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('grid-lod-2-medium.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('lod 4 - zoomed in (5° spacing)', async () => {
    await zero.OptionsService.toggleLayer('grid', true);
    await zero.OptionsService.setOpacity('grid', 1.0);
    await zero.OptionsService.set('grid.lineWidth', 2);
    await zero.AuroraService.setCamera(0, 0, 1.2);  // Close
    await page.waitForTimeout(2000);  // Wait for animation to settle

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('grid-lod-4-close.png', {
      maxDiffPixelRatio: 0,
    });
  });
});
