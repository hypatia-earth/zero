import { test, expect } from '@playwright/test';
import { waitForAppReady, waitForLayerReady, readCenterPixel } from '../helpers';

// O1280 grid: 6,599,680 points
const O1280_POINTS = 6_599_680;

// Test cases: [palette, tempC, opacity, expectedRGB]
const testCases: Array<{
  palette: 'classic' | 'gradient' | 'hypatia';
  tempC: number;
  opacity: number;
  rgb: { r: number; g: number; b: number };
}> = [
  // Classic palette tests at full opacity (sun disabled)
  { palette: 'classic', tempC: 35, opacity: 1.0, rgb: { r: 209, g: 122, b: 61 } },
  { palette: 'classic', tempC: -20, opacity: 1.0, rgb: { r: 143, g: 168, b: 184 } },
];

test.describe('temp layer deterministic', () => {
  for (const { palette, tempC, opacity, rgb } of testCases) {
    test(`${palette} ${tempC}°C @${opacity} → rgb(${rgb.r},${rgb.g},${rgb.b})`, async ({ page }) => {
      // Set test data BEFORE page loads
      await page.addInitScript(({ points, temp }) => {
        (window as any).__zeroTestData = {
          temp: new Float32Array(points).fill(temp)
        };
      }, { points: O1280_POINTS, temp: tempC });

      const bootstrapPromise = page.waitForEvent('console', {
        predicate: msg => msg.text().includes('[ZERO] Bootstrap complete'),
        timeout: 60000
      });

      // temp-only (no earth) for exact color
      await page.goto(`/?layers=temp&palette=${palette}`);
      await bootstrapPromise;

      // Set palette and opacity (sun already disabled by layers=temp)
      await page.evaluate(({ paletteName, opacity }) => {
        const h = (window as any).__hypatia;
        h?.paletteService?.setPalette('temp', paletteName);
        h?.optionsService?.update((d: any) => {
          d.temp.opacity = opacity;
        });
      }, { paletteName: palette === 'classic' ? 'Classic Temperature' : palette, opacity });

      await page.waitForTimeout(500);

      const pixel = await readCenterPixel(page);
      console.log(`${palette} ${tempC}°C:`, pixel);

      // Exact RGB match (allow ±1 for rounding)
      expect(pixel.r).toBeGreaterThanOrEqual(rgb.r - 1);
      expect(pixel.r).toBeLessThanOrEqual(rgb.r + 1);
      expect(pixel.g).toBeGreaterThanOrEqual(rgb.g - 1);
      expect(pixel.g).toBeLessThanOrEqual(rgb.g + 1);
      expect(pixel.b).toBeGreaterThanOrEqual(rgb.b - 1);
      expect(pixel.b).toBeLessThanOrEqual(rgb.b + 1);
    });
  }
});

test.describe('temp.enabled', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('toggle on shows temperature layer', async ({ page }) => {
    // Enable temp layer with earth
    await page.evaluate(() => {
      const opts = (window as any).__hypatia.optionsService;
      opts.update((d: any) => {
        d.earth.enabled = true;
        d.temp.enabled = true;
        d.temp.opacity = 1.0;
      });
    });

    // Wait for temp data
    await waitForLayerReady(page, 'temp');
    await page.waitForTimeout(500);

    // Sample center pixel - should show globe content (not background)
    const pixel = await readCenterPixel(page);

    console.log('Temp ON - center pixel:', pixel);

    // Background is (22, 22, 22) - globe content should differ
    const isBackground = pixel.r === 22 && pixel.g === 22 && pixel.b === 22;
    expect(isBackground).toBe(false);
  });

  test('toggle off hides temperature layer', async ({ page }) => {
    // Enable earth + temp
    await page.evaluate(() => {
      const opts = (window as any).__hypatia.optionsService;
      opts.update((d: any) => {
        d.earth.enabled = true;
        d.temp.enabled = true;
        d.temp.opacity = 1.0;
      });
    });
    await waitForLayerReady(page, 'temp');
    await page.waitForTimeout(500);

    // Capture pixel with temp ON
    const pixelOn = await readCenterPixel(page);

    // Disable temp
    await page.evaluate(() => {
      (window as any).__hypatia.optionsService.update((d: any) => {
        d.temp.enabled = false;
      });
    });
    await page.waitForTimeout(500);

    // Capture pixel with temp OFF
    const pixelOff = await readCenterPixel(page);

    console.log('Temp ON:', pixelOn, 'Temp OFF:', pixelOff);

    // Pixels should differ when temp is toggled
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

    // Verify it's enabled
    const enabledBefore = await page.evaluate(() =>
      (window as any).__hypatia.optionsService.options.value.temp.enabled
    );
    expect(enabledBefore).toBe(true);

    // Reload
    await page.reload();
    await waitForAppReady(page);

    // Verify still enabled
    const enabledAfter = await page.evaluate(() =>
      (window as any).__hypatia.optionsService.options.value.temp.enabled
    );
    expect(enabledAfter).toBe(true);
  });
});
