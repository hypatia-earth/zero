/**
 * Options Persistence E2E Test
 *
 * Generic test that verifies ALL options persist after reload.
 * Uses schema metadata to mutate options within valid ranges.
 */

import { test, expect } from '@playwright/test';
import { createZeroAPI, waitForAppReady } from '../helpers';

// Fields to skip (internal, complex, or not user-facing)
const SKIP_PATHS = new Set([
  '_version',
  'pressure.colors',
  'prefetch.enabled',
  'prefetch.forecastDays',
  'prefetch.temp',
  'prefetch.pressure',
  'prefetch.wind',
]);

test.describe('options persistence', () => {
  test('all options persist after reload', async ({ page }) => {
    const zero = createZeroAPI(page);

    // Clear IndexedDB and load fresh
    await page.goto('https://localhost:5173/');
    await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
    });
    await page.reload();
    await waitForAppReady(page);

    // Get schema-aware mutations for all options
    const mutations = await zero.Schema.getMutations([...SKIP_PATHS]);

    console.log(`Mutating ${Object.keys(mutations).length} options`);

    // Apply all mutations in one update
    await zero.OptionsService.setMany(mutations);

    // Wait for debounced save
    await page.waitForTimeout(700);

    // Reload
    await page.reload();
    await waitForAppReady(page);

    // Verify persistence
    const failures: string[] = [];
    for (const [path, expectedVal] of Object.entries(mutations)) {
      const actual = await zero.OptionsService.get(path);

      if (typeof expectedVal === 'number') {
        if (Math.abs(expectedVal - (actual as number)) > 0.01) {
          failures.push(`${path}: expected ${expectedVal}, got ${actual}`);
        }
      } else if (expectedVal !== actual) {
        failures.push(`${path}: expected ${expectedVal}, got ${actual}`);
      }
    }

    if (failures.length > 0) {
      console.log('Persistence failures:');
      failures.forEach(f => console.log(`  ${f}`));
    }

    expect(failures).toHaveLength(0);
  });
});
