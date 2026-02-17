/**
 * Pipeline: Slot Resize E2E Test
 *
 * Verifies that changing gpu.timeslotsPerLayer at runtime
 * correctly grows/shrinks ParamSlots capacity and loads data
 * without warnings or errors.
 *
 * Sequence: 4 (default) → 8 → 16 → 2 (shrink)
 */

import { test, expect } from '@playwright/test';
import { createZeroAPI, waitForAppReady } from '../helpers';

const PARAM = 'temperature_2m';

/** Collect console warnings/errors during a callback */
async function withConsoleWatch(
  page: import('@playwright/test').Page,
  fn: () => Promise<void>,
): Promise<string[]> {
  const issues: string[] = [];
  const handler = (msg: import('@playwright/test').ConsoleMessage) => {
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
      await zero.OptionsService.set('gpu.timeslotsPerLayer', '8');
      // Nudge time to trigger queue
      await page.evaluate(() => {
        const state = (window as any).__hypatia.stateService;
        const t = new Date(state.viewState.value.time.getTime() + 3600000);
        state.setTime(t);
      });
      await page.waitForTimeout(10000);
    });

    const stats8 = await zero.SlotService.getSlotStats();
    expect(stats8[PARAM]?.capacity).toBe(8);
    expect(issues8).toHaveLength(0);

    // --- GROW: 8 → 16 ---
    const issues16 = await withConsoleWatch(page, async () => {
      await zero.OptionsService.set('gpu.timeslotsPerLayer', '16');
      await page.evaluate(() => {
        const state = (window as any).__hypatia.stateService;
        const t = new Date(state.viewState.value.time.getTime() + 3600000);
        state.setTime(t);
      });
      await page.waitForTimeout(10000);
    });

    const stats16 = await zero.SlotService.getSlotStats();
    expect(stats16[PARAM]?.capacity).toBe(16);
    expect(issues16).toHaveLength(0);

    // --- SHRINK: 16 → 2 ---
    const issues2 = await withConsoleWatch(page, async () => {
      await zero.OptionsService.set('gpu.timeslotsPerLayer', '2');
      await page.evaluate(() => {
        const state = (window as any).__hypatia.stateService;
        const t = new Date(state.viewState.value.time.getTime() + 3600000);
        state.setTime(t);
      });
      await page.waitForTimeout(10000);
    });

    const stats2 = await zero.SlotService.getSlotStats();
    expect(stats2[PARAM]?.capacity).toBe(2);
    expect(stats2[PARAM]!.loaded).toBeLessThanOrEqual(2);
    expect(issues2).toHaveLength(0);
  });
});
