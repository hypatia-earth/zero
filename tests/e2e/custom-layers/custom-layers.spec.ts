/**
 * Custom Layer E2E Tests
 *
 * Tests the create-layer dialog and custom layer rendering.
 * Uses the default red-green shader template with temperature data.
 *
 * Update screenshots: npm run test:e2e -- custom-layer --update-snapshots
 */

import { test, expect, Page } from '@playwright/test';
import {
  createZeroAPI,
  loadFixture,
  waitForAppReady,
  setupTestEnv,
  expectNotBackground,
  type ZeroTestAPI,
} from '../helpers';

const FIXTURE_55 = loadFixture('uniform-55');

let page: Page;
let zero: ZeroTestAPI;

test.describe('custom layer', () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    zero = createZeroAPI(page);
    await page.goto('https://localhost:5173/?layers=earth&lon=0&lat=0&alt=2000');
    await waitForAppReady(page);
    await setupTestEnv(page);

    // Pre-inject temperature data — uploads to temperature_2m param buffer on GPU
    await zero.SlotService.injectTestData('temp', FIXTURE_55);
    await page.waitForTimeout(300);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('create via dialog, try, cancel - renders red/green', async () => {
    // Open create layer dialog
    await page.getByTestId('add-layer-btn').click();
    await page.waitForTimeout(300);

    // Set layer ID
    await page.getByTestId('layer-id-input').fill('layertest');

    // Verify temperature param is default
    await expect(page.getByTestId('layer-param-select')).toHaveValue('temperature_2m');

    // Render order 50 (default), opacity 50% (default)
    await page.getByTestId('layer-order-input').fill('50');

    // Click Try to preview the custom layer
    await page.getByTestId('layer-try-btn').click();
    await page.waitForTimeout(1500);  // Wait for shader recompilation + render

    // Verify no shader error
    await expect(page.getByTestId('layer-error')).not.toBeVisible();

    // Hide UI to read canvas behind dialog
    await zero.UI.hide();
    await page.waitForTimeout(200);

    // Verify globe renders custom layer (red-green, not background)
    const pixel = await zero.Canvas.readCenterPixel();
    expectNotBackground(pixel);

    // Restore UI and cancel
    await zero.UI.show();
    await page.getByTestId('layer-cancel-btn').click();
    await page.waitForTimeout(300);

    // Dialog should be closed
    await expect(page.locator('.dialog.create-layer')).not.toBeVisible();
  });
});
