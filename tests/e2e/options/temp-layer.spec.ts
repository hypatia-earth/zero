/**
 * Temperature Layer E2E Tests
 *
 * Single page load - all tests share one bootstrap.
 * Uses ZeroTestAPI for clean test code.
 */

import { test, expect, Page } from '@playwright/test';
import {
  createZeroAPI,
  loadFixture,
  waitForAppReady,
  setupTestEnv,
  expectRgb,
  expectBackground,
  blendRgb,
  type ZeroTestAPI,
  type RGB,
} from '../helpers';

// Fixture data
const FIXTURE_55 = loadFixture('uniform-55');
const FIXTURE_MINUS20 = loadFixture('uniform-minus20');

// Expected RGB values from Classic Temperature palette
const RGB_55: RGB = [107, 28, 43];        // 55°C (above max, clamped)
const RGB_MINUS20: RGB = [112, 143, 166]; // -20°C = -4°F → -5°F band in Classic

let page: Page;
let zero: ZeroTestAPI;

test.describe('temp layer', () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    zero = createZeroAPI(page);
    await page.goto('https://localhost:5173/?layers=earth');
    await waitForAppReady(page);
    await setupTestEnv(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test.afterEach(async () => {
    await zero.OptionsService.toggleLayer('temp', false);
  });

  // ============================================================
  // Pixel Tests - uniform-55 fixture
  // ============================================================

  test('55°C renders correct RGB at opacity 1.0', async () => {
    await zero.PaletteService.setPalette('temp', 'Classic Temperature');
    await zero.OptionsService.toggleLayer('temp', true);
    await zero.OptionsService.setOpacity('temp', 1.0);
    await page.waitForTimeout(300);
    await zero.SlotService.injectTestData('temp', FIXTURE_55);
    await page.waitForTimeout(300);

    const pixel = await zero.Canvas.readCenterPixel();
    expectRgb(pixel, RGB_55);
  });

  test('55°C at opacity 0.5 blends with background', async () => {
    await zero.PaletteService.setPalette('temp', 'Classic Temperature');
    await zero.OptionsService.toggleLayer('temp', true);
    await zero.OptionsService.setOpacity('temp', 0.5);
    await page.waitForTimeout(300);
    await zero.SlotService.injectTestData('temp', FIXTURE_55);
    await page.waitForTimeout(300);

    const pixel = await zero.Canvas.readCenterPixel();
    expectRgb(pixel, blendRgb(RGB_55, 0.5));
  });

  test('55°C at opacity 0.0 shows background', async () => {
    await zero.OptionsService.toggleLayer('temp', true);
    await zero.OptionsService.setOpacity('temp', 0.0);
    await page.waitForTimeout(300);
    await zero.SlotService.injectTestData('temp', FIXTURE_55);
    await page.waitForTimeout(300);

    const pixel = await zero.Canvas.readCenterPixel();
    expectBackground(pixel);
  });

  // ============================================================
  // Pixel Tests - uniform-minus20 fixture
  // ============================================================

  test('-20°C renders correct RGB', async () => {
    await zero.PaletteService.setPalette('temp', 'Classic Temperature');
    await zero.OptionsService.toggleLayer('temp', true);
    await zero.OptionsService.setOpacity('temp', 1.0);
    await page.waitForTimeout(300);
    await zero.SlotService.injectTestData('temp', FIXTURE_MINUS20);
    await page.waitForTimeout(300);

    const pixel = await zero.Canvas.readCenterPixel();
    expectRgb(pixel, RGB_MINUS20);
  });

  // ============================================================
  // Toggle Tests
  // ============================================================

  test('toggle off shows background', async () => {
    await zero.OptionsService.toggleLayer('temp', true);
    await page.waitForTimeout(300);
    await zero.SlotService.injectTestData('temp', FIXTURE_55);
    await page.waitForTimeout(300);

    // Verify something is rendered
    let pixel = await zero.Canvas.readCenterPixel();
    expect(pixel.r).not.toBe(22);

    // Toggle off
    await zero.OptionsService.toggleLayer('temp', false);
    await page.waitForTimeout(300);

    pixel = await zero.Canvas.readCenterPixel();
    expectBackground(pixel);
  });

  // ============================================================
  // Palette Tests
  // ============================================================

  test('palette change affects color', async () => {
    await zero.PaletteService.setPalette('temp', 'Classic Temperature');
    await zero.OptionsService.toggleLayer('temp', true);
    await page.waitForTimeout(300);
    await zero.SlotService.injectTestData('temp', FIXTURE_55);
    await page.waitForTimeout(300);

    const pixelClassic = await zero.Canvas.readCenterPixel();

    await zero.PaletteService.setPalette('temp', 'Hypatia Temperature');
    await page.waitForTimeout(500);  // Extra time for worker palette update

    const pixelHypatia = await zero.Canvas.readCenterPixel();

    const changed = pixelClassic.r !== pixelHypatia.r ||
                   pixelClassic.g !== pixelHypatia.g ||
                   pixelClassic.b !== pixelHypatia.b;
    expect(changed).toBe(true);
  });
});

