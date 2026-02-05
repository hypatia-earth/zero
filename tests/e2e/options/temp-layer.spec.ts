/**
 * Temperature Layer E2E Tests
 *
 * Two test groups:
 *
 * 1. DETERMINISTIC PIXEL TESTS
 *    - Inject uniform fixture data (e.g., all pixels = 55°C)
 *    - Only temp layer enabled (no earth/sun)
 *    - Assert exact RGB from palette lookup
 *    - Tests the full render pipeline: data → palette → shader → pixel
 *
 * 2. BEHAVIORAL TESTS
 *    - Use live server data
 *    - Earth + temp enabled (realistic scenario)
 *    - Assert relative behavior (pixel changes, state persists)
 *    - Tests UI interactions and state management
 */

import { test, expect } from '@playwright/test';
import { testLayerPixels, waitForAppReady, waitForLayerReady, readCenterPixel } from '../helpers';

/**
 * DETERMINISTIC PIXEL TESTS
 *
 * These test exact RGB output for known input data.
 * Background is clear color (22,22,22) since earth/sun disabled.
 *
 * baseRgb values come from the Classic Temperature palette:
 * - 55°C (above palette max ~52°C) → clamped to last stop [107, 28, 43]
 * - -20°C → palette lookup gives [143, 168, 184]
 *
 * Generate fixtures: python tests/scripts/generate_test_bins.py
 */
testLayerPixels('temp', [
  { fixture: 'uniform-55', palette: 'Classic Temperature', baseRgb: [107, 28, 43] },
  { fixture: 'uniform-minus20', palette: 'Classic Temperature', baseRgb: [143, 168, 184] },
  { fixture: 'uniform-55', palette: 'Classic Temperature', baseRgb: [107, 28, 43], opacities: [0.5] },
]);

/**
 * BEHAVIORAL TESTS
 *
 * These test UI interactions with live data.
 * Earth is enabled to simulate realistic usage.
 * Assertions check relative changes, not exact RGB.
 */
test.describe('temp.enabled', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('toggle on shows temperature layer', async ({ page }) => {
    // Enable earth + temp (realistic scenario)
    await page.evaluate(() => {
      (window as any).__hypatia.optionsService.update((d: any) => {
        d.earth.enabled = true;
        d.temp.enabled = true;
        d.temp.opacity = 1.0;
      });
    });

    await waitForLayerReady(page, 'temp');
    await page.waitForTimeout(500);

    // Assert: center pixel is NOT the background color
    const pixel = await readCenterPixel(page);
    const isBackground = pixel.r === 22 && pixel.g === 22 && pixel.b === 22;
    expect(isBackground).toBe(false);
  });

  test('toggle off hides temperature layer', async ({ page }) => {
    // Enable earth + temp
    await page.evaluate(() => {
      (window as any).__hypatia.optionsService.update((d: any) => {
        d.earth.enabled = true;
        d.temp.enabled = true;
        d.temp.opacity = 1.0;
      });
    });
    await waitForLayerReady(page, 'temp');
    await page.waitForTimeout(500);
    const pixelOn = await readCenterPixel(page);

    // Disable temp
    await page.evaluate(() => {
      (window as any).__hypatia.optionsService.update((d: any) => {
        d.temp.enabled = false;
      });
    });
    await page.waitForTimeout(500);
    const pixelOff = await readCenterPixel(page);

    // Assert: pixel changed when temp toggled off
    const changed = pixelOn.r !== pixelOff.r || pixelOn.g !== pixelOff.g || pixelOn.b !== pixelOff.b;
    expect(changed).toBe(true);
  });

  test('temp.enabled persists after reload', async ({ page }) => {
    // Enable temp
    await page.evaluate(() => {
      (window as any).__hypatia.optionsService.update((d: any) => {
        d.temp.enabled = true;
      });
    });

    const enabledBefore = await page.evaluate(() =>
      (window as any).__hypatia.optionsService.options.value.temp.enabled
    );
    expect(enabledBefore).toBe(true);

    // Reload page
    await page.reload();
    await waitForAppReady(page);

    // Assert: temp still enabled after reload
    const enabledAfter = await page.evaluate(() =>
      (window as any).__hypatia.optionsService.options.value.temp.enabled
    );
    expect(enabledAfter).toBe(true);
  });
});
