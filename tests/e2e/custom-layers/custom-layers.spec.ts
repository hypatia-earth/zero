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

    // Clear stale user layers from previous test runs
    await page.evaluate(() => {
      const ls = (window as any).__hypatia.layerService;
      const custom = ls.getAll().filter((l: any) => !l.isBuiltIn);
      for (const l of custom) {
        ls.unregisterUserLayer(l.id);
        void ls.deleteUserLayer(l.id);
      }
    });

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

    // Click Try, re-inject data to bump slotsVersion signal, wait for Save to enable
    await page.getByTestId('layer-try-btn').click();
    await page.waitForTimeout(500);
    await zero.SlotService.injectTestData('temp', FIXTURE_55);
    await expect(page.getByTestId('layer-save-btn')).toBeEnabled({ timeout: 10000 });

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
    await page.getByTestId('layer-close-btn').click();
    await page.waitForTimeout(300);

    // Dialog should be closed
    await expect(page.locator('.dialog.create-layer')).not.toBeVisible();
  });

  test('create via dialog, try, save - button appears', async () => {
    // Open create layer dialog
    await page.getByTestId('add-layer-btn').click();
    await page.waitForTimeout(300);

    // Set layer ID
    await page.getByTestId('layer-id-input').fill('layersave');

    // Click Try, re-inject data to bump slotsVersion signal, wait for Save to enable
    await page.getByTestId('layer-try-btn').click();
    await page.waitForTimeout(500);
    await zero.SlotService.injectTestData('temp', FIXTURE_55);
    await expect(page.getByTestId('layer-save-btn')).toBeEnabled({ timeout: 10000 });
    await expect(page.getByTestId('layer-error')).not.toBeVisible();

    await page.getByTestId('layer-save-btn').click();
    await page.waitForTimeout(300);

    // Dialog stays open after save
    await expect(page.locator('.dialog.create-layer')).toBeVisible();

    // Layer button should appear in layers panel with correct name
    await expect(page.locator('.layer.widget button.toggle', { hasText: 'layersave' })).toBeVisible();

    // Close manually
    await page.getByTestId('layer-close-btn').click();
    await page.waitForTimeout(300);
  });

  test('create, save, delete - button removed', async () => {
    // Open create layer dialog
    await page.getByTestId('add-layer-btn').click();
    await page.waitForTimeout(300);

    // Set layer ID
    await page.getByTestId('layer-id-input').fill('layerdelete');

    // Try, re-inject data to bump slotsVersion signal, wait for Save to enable
    await page.getByTestId('layer-try-btn').click();
    await page.waitForTimeout(500);
    await zero.SlotService.injectTestData('temp', FIXTURE_55);
    await expect(page.getByTestId('layer-save-btn')).toBeEnabled({ timeout: 10000 });
    await expect(page.getByTestId('layer-error')).not.toBeVisible();

    await page.getByTestId('layer-save-btn').click();
    await page.waitForTimeout(300);

    // Reload to test IDB persistence and get clean mithril state
    await page.reload();
    await waitForAppReady(page);
    await setupTestEnv(page);

    // Verify button persisted
    const layerButton = page.locator('.layer.widget button.toggle', { hasText: 'layerdelete' });
    await expect(layerButton).toBeVisible();

    // Open edit dialog via gear icon
    const widget = page.locator('.layer.widget', { hasText: 'layerdelete' });
    await widget.locator('button.options').click();
    await page.waitForTimeout(300);

    // Delete the layer — confirm modal
    await page.getByTestId('layer-delete-btn').click();
    await page.locator('.modal-buttons button.danger').click();
    await page.waitForTimeout(300);

    // Button should be removed
    await expect(layerButton).not.toBeVisible();
  });
});
