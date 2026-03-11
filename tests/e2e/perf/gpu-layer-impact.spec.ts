/**
 * GPU Layer Impact — Performance Baseline
 *
 * Measures per-layer GPU cost at three zoom levels.
 * Writes results to tests/e2e/perf/results/<timestamp>.json
 *
 * Run: npm run test:e2e -- perf/gpu-layer-impact
 * Run headed: npm run test:e2e:headed -- perf/gpu-layer-impact
 */

import { test, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  createZeroAPI,
  waitForAppReady,
  type ZeroTestAPI,
  type PerfMetrics,
  type PerfEnvironment,
} from '../helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RESULTS_DIR = path.join(__dirname, 'results');

const SETTLE_MS = 2000;

/** Local archive event — deterministic data, no downloads */
const EVENT = '2026-03-01--2026-03-01';

const LAYERS = [
  'earth', 'sun', 'graticule', 'cities',
  'temp', 'rain', 'clouds', 'pressure', 'wind',
] as const;

const ZOOM_LEVELS = [
  { alt: 300,   label: 'close' },
  { alt: 3000,  label: 'mid' },
  { alt: 30000, label: 'far' },
] as const;

// ============================================================
// Types
// ============================================================

interface Measurement {
  label: string;
  enabledLayers: string[];
  metrics: PerfMetrics;
}

interface ZoomResult {
  alt: number;
  zoomLabel: string;
  globePx: number;
  measurements: Measurement[];
}

interface TestReport {
  timestamp: string;
  environment: PerfEnvironment;
  zoomLevels: ZoomResult[];
}

// ============================================================
// Helpers
// ============================================================

async function disableAllLayers(zero: ZeroTestAPI): Promise<void> {
  for (const layer of LAYERS) {
    await zero.OptionsService.toggleLayer(layer, false);
  }
}

async function enableLayers(zero: ZeroTestAPI, layers: string[]): Promise<void> {
  for (const layer of LAYERS) {
    await zero.OptionsService.toggleLayer(layer, layers.includes(layer));
  }
}

async function measure(
  page: Page,
  zero: ZeroTestAPI,
  label: string,
  layers: string[],
): Promise<Measurement> {
  await enableLayers(zero, layers);
  await page.waitForTimeout(SETTLE_MS);
  const metrics = await zero.PerfService.readMetrics();
  return { label, enabledLayers: layers, metrics };
}

// ============================================================
// Test
// ============================================================

test.describe('GPU layer impact', () => {
  let page: Page;
  let zero: ZeroTestAPI;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    zero = createZeroAPI(page);
    // Start with layers off, perf panel on
    await page.goto(`https://localhost:5173/?event=${EVENT}&layers=none&lon=10&lat=45`);
    await waitForAppReady(page);
    // Ensure perf panel is visible
    await zero.OptionsService.set('debug.showPerfPanel', true);
    await zero.OptionsService.set('debug.fpsLimit', 'off');
    await zero.OptionsService.set('debug.renderScale', '1');
    await disableAllLayers(zero);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('measure layer impact across zoom levels', async () => {
    test.setTimeout(0); // no timeout — this takes minutes

    const environment = await zero.PerfService.readEnvironment();
    const zoomLevels: ZoomResult[] = [];

    for (const zoom of ZOOM_LEVELS) {
      // Set zoom via camera altitude
      await zero.AuroraService.setCamera(10, 45, zoom.alt);
      await page.waitForTimeout(SETTLE_MS);

      const measurements: Measurement[] = [];

      // --- Baseline: no layers ---
      measurements.push(await measure(page, zero, 'none', []));

      // --- Each layer alone ---
      for (const layer of LAYERS) {
        measurements.push(await measure(page, zero, layer, [layer]));
      }

      // --- All layers on ---
      const allLayers = [...LAYERS];
      measurements.push(await measure(page, zero, 'all', allLayers));

      // --- All minus one ---
      for (const excluded of LAYERS) {
        const subset = allLayers.filter(l => l !== excluded);
        measurements.push(await measure(page, zero, `all-minus-${excluded}`, subset));
      }

      // Read globe size at this zoom
      const globePx = measurements[0].metrics.globePx;

      zoomLevels.push({
        alt: zoom.alt,
        zoomLabel: zoom.label,
        globePx,
        measurements,
      });
    }

    // --- Write results ---
    const report: TestReport = {
      timestamp: new Date().toISOString(),
      environment,
      zoomLevels,
    };

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const filename = `perf-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filepath = path.join(RESULTS_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2));

    console.log(`\nResults written to: ${filepath}`);
    console.log(formatSummary(report));
  });
});

// ============================================================
// Summary Formatter
// ============================================================

function formatSummary(report: TestReport): string {
  const lines: string[] = ['\n=== GPU Layer Impact ===\n'];

  for (const zoom of report.zoomLevels) {
    lines.push(`\n--- ${zoom.zoomLabel} (alt=${zoom.alt}, globe=${zoom.globePx}px) ---`);
    lines.push(
      padRight('scenario', 20) +
      padRight('fps', 6) +
      padRight('frame', 8) +
      padRight('p1', 8) +
      padRight('p2', 8) +
      padRight('p3', 8)
    );
    lines.push('-'.repeat(58));

    for (const m of zoom.measurements) {
      const { fps, frameMs, p1, p2, p3 } = m.metrics;
      lines.push(
        padRight(m.label, 20) +
        padRight(String(fps), 6) +
        padRight(frameMs.toFixed(2), 8) +
        padRight(p1.toFixed(2), 8) +
        padRight(p2.toFixed(2), 8) +
        padRight(p3.toFixed(2), 8)
      );
    }
  }

  return lines.join('\n');
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}
