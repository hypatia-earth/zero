/**
 * Wind Layer E2E Tests
 *
 * Screenshot-based tests for wind layer options.
 * Uses cyclonic pattern fixture centered at 0,0.
 *
 * Generate fixtures: python tests/scripts/generate_wind_fixtures.py
 * Update screenshots: npm run test:e2e -- wind-layer --update-snapshots
 */

import { test, expect, Page } from '@playwright/test';
import {
  createZeroAPI,
  loadFixture,
  waitForAppReady,
  setupTestEnv,
  type ZeroTestAPI,
} from '../helpers';

// Fixture data: cyclonic wind pattern at 0,0
const FIXTURE_U = loadFixture('wind-cyclone-u');
const FIXTURE_V = loadFixture('wind-cyclone-v');

let page: Page;
let zero: ZeroTestAPI;

test.describe('wind layer', () => {
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
    await zero.OptionsService.toggleLayer('wind', false);
    await page.waitForTimeout(100);
  });

  // ============================================================
  // Enable/Disable
  // ============================================================

  test('enabled - cyclone visible', async () => {
    await zero.OptionsService.toggleLayer('wind', true);
    await zero.OptionsService.setOpacity('wind', 1.0);
    await zero.OptionsService.set('wind.seedCount', 32768);
    await zero.OptionsService.set('wind.speed', 0);  // Freeze animation
    await page.waitForTimeout(300);
    await zero.SlotService.injectTestData('wind', [FIXTURE_U, FIXTURE_V]);
    await page.waitForTimeout(500);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('wind-enabled.png', {
      maxDiffPixelRatio: 0,
    });
  });

  // ============================================================
  // Opacity Tests
  // ============================================================

  test('opacity 0.3 - faint lines', async () => {
    await zero.OptionsService.toggleLayer('wind', true);
    await zero.OptionsService.setOpacity('wind', 0.3);
    await zero.OptionsService.set('wind.seedCount', 32768);
    await zero.OptionsService.set('wind.speed', 0);  // Freeze animation
    await page.waitForTimeout(300);
    await zero.SlotService.injectTestData('wind', [FIXTURE_U, FIXTURE_V]);
    await page.waitForTimeout(500);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('wind-opacity-30.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('opacity 1.0 - full brightness', async () => {
    await zero.OptionsService.toggleLayer('wind', true);
    await zero.OptionsService.setOpacity('wind', 1.0);
    await zero.OptionsService.set('wind.seedCount', 32768);
    await zero.OptionsService.set('wind.speed', 0);  // Freeze animation
    await page.waitForTimeout(300);
    await zero.SlotService.injectTestData('wind', [FIXTURE_U, FIXTURE_V]);
    await page.waitForTimeout(500);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('wind-opacity-100.png', {
      maxDiffPixelRatio: 0,
    });
  });

  // ============================================================
  // Seed Count Tests
  // ============================================================

  test('seedCount 8K - sparse lines', async () => {
    await zero.OptionsService.toggleLayer('wind', true);
    await zero.OptionsService.setOpacity('wind', 1.0);
    await zero.OptionsService.set('wind.seedCount', 8192);
    await zero.OptionsService.set('wind.speed', 0);  // Freeze animation
    await page.waitForTimeout(300);
    await zero.SlotService.injectTestData('wind', [FIXTURE_U, FIXTURE_V]);
    await page.waitForTimeout(500);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('wind-seedcount-8k.png', {
      maxDiffPixelRatio: 0,
    });
  });

  test('seedCount 64K - dense lines', async () => {
    await zero.OptionsService.toggleLayer('wind', true);
    await zero.OptionsService.setOpacity('wind', 1.0);
    await zero.OptionsService.set('wind.seedCount', 65536);
    await zero.OptionsService.set('wind.speed', 0);  // Freeze animation
    await page.waitForTimeout(300);
    await zero.SlotService.injectTestData('wind', [FIXTURE_U, FIXTURE_V]);
    await page.waitForTimeout(500);

    const canvas = page.locator('#globe');
    await expect(canvas).toHaveScreenshot('wind-seedcount-64k.png', {
      maxDiffPixelRatio: 0,
    });
  });
});
