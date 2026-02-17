/**
 * Pipeline: Slot Resize E2E Test
 *
 * Verifies that changing gpu.timeslotsPerLayer via the UI
 * correctly grows/shrinks ParamSlots capacity and loads data
 * without warnings or errors.
 *
 * Uses real UI interactions: gear icon → options dialog → select dropdown.
 * Sequence: 4 (default) → 8 → 16 → 2 (shrink)
 */

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { createZeroAPI, waitForAppReady, pauseIfHeaded } from '../helpers';

const PARAM = 'temperature_2m';
const TIMESLOTS_TESTID = 'gpu.timeslotsPerLayer';

/** Open the options dialog by clicking the gear icon */
async function openOptions(page: Page): Promise<void> {
  await page.locator('.panel.options button.control.circle').click();
  await page.waitForSelector('.dialog.options .window', { state: 'visible' });
}

/** Close the options dialog */
async function closeOptions(page: Page): Promise<void> {
  await page.locator('.dialog.options .footer button.btn-secondary').last().click();
  await page.waitForSelector('.dialog.options', { state: 'hidden' });
}

/** Select a timeslots value from the dropdown */
async function selectTimeslots(page: Page, value: string): Promise<void> {
  await page.locator(`[data-testid="${TIMESLOTS_TESTID}"] select`).selectOption(value);
}

/** Collect console warnings/errors during a callback */
async function withConsoleWatch(page: Page, fn: () => Promise<void>): Promise<string[]> {
  const issues: string[] = [];
  const handler = (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type === 'warning' || type === 'error') {
      issues.push(`[${type}] ${msg.text()}`);
    }
  };
  page.on('console', handler);
  await fn();
  page.off('console', handler);
  return issues;
}

test.describe('slot resize', () => {
  test('grow 4→8→16 then shrink to 2', async ({ page }) => {
    test.setTimeout(120000);
    const zero = createZeroAPI(page);

    // Clear IDB for clean default state
    await page.goto('https://localhost:5173/');
    await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
    });

    // Load with only temp layer to keep it focused
    await page.goto('https://localhost:5173/?layers=temp');
    await waitForAppReady(page);

    // Verify default: 4 slots
    const initial = await zero.SlotService.getSlotStats();
    expect(initial[PARAM]?.capacity).toBe(4);

    // --- GROW: 4 → 8 ---
    const issues8 = await withConsoleWatch(page, async () => {
      await openOptions(page);
      await selectTimeslots(page, '8');
      await closeOptions(page);
      await page.waitForTimeout(10000);
    });

    const stats8 = await zero.SlotService.getSlotStats();
    expect(stats8[PARAM]?.capacity).toBe(8);
    expect(issues8).toHaveLength(0);

    // --- GROW: 8 → 16 ---
    const issues16 = await withConsoleWatch(page, async () => {
      await openOptions(page);
      await selectTimeslots(page, '16');
      await closeOptions(page);
      await page.waitForTimeout(10000);
    });

    const stats16 = await zero.SlotService.getSlotStats();
    expect(stats16[PARAM]?.capacity).toBe(16);
    expect(issues16).toHaveLength(0);

    // --- SHRINK: 16 → 2 ---
    const issues2 = await withConsoleWatch(page, async () => {
      await openOptions(page);
      await selectTimeslots(page, '2');
      await closeOptions(page);
      await page.waitForTimeout(10000);
    });

    const stats2 = await zero.SlotService.getSlotStats();
    expect(stats2[PARAM]?.capacity).toBe(2);
    expect(stats2[PARAM]!.loaded).toBeLessThanOrEqual(2);
    expect(issues2).toHaveLength(0);

    await pauseIfHeaded(page);
  });
});
