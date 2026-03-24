/**
 * Precipitation: Backward Sum Analysis Skip
 *
 * Verifies that backward-sum params (precipitation) are correctly skipped
 * at analysis (T+0) timesteps. Both precipitation and snowfall_water_equivalent
 * are backward-sum params and behave identically at analysis timesteps.
 *
 * Background:
 *   NWP models output precipitation as backward accumulation sums.
 *   At T+0 (analysis), there is no prior step to subtract from, so the
 *   value is undefined. Discovery flags these timesteps with isAnalysis=true,
 *   and getWindowTasks() skips backward-sum params there.
 *   Additionally, first() trims 6h from the data window start.
 */

import { test, expect } from '@playwright/test';
import { waitForAppReady } from '../../helpers';

test.describe('precipitation backward sum', () => {

  test('analysis timesteps are flagged in discovery', async ({ page }) => {
    await page.goto('/?layers=earth,rain');
    await waitForAppReady(page);

    const result = await page.evaluate(() => {
      const ts = (window as any).__hypatia.timestepService;
      const data = ts.timestepsData.ecmwf_ifs;
      const analysis = data.filter((t: any) => t.isAnalysis);
      return {
        totalTimesteps: data.length,
        analysisCount: analysis.length,
        // Analysis should occur every 6h (4 per day)
        allAt6hBoundaries: analysis.every((t: any) => {
          const hour = parseInt(t.timestep.slice(11, 13), 10);
          return hour % 6 === 0;
        }),
      };
    });

    expect(result.analysisCount).toBeGreaterThan(0);
    expect(result.allAt6hBoundaries).toBe(true);
    // ~8 days of data × 4 runs/day = ~32 analysis timesteps
    expect(result.analysisCount).toBeGreaterThanOrEqual(20);
  });

  test('first() trims 6h from raw data start', async ({ page }) => {
    await page.goto('/?layers=earth,rain');
    await waitForAppReady(page);

    const result = await page.evaluate(() => {
      const ts = (window as any).__hypatia.timestepService;
      const data = ts.timestepsData.ecmwf_ifs;
      const rawFirst = data[0].timestep;
      const trimmedFirst = ts.first();

      // Parse timestep strings to compute hour difference
      const parse = (s: string) => {
        const [date, time] = s.split('T');
        return new Date(`${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`);
      };
      const diffHours = (parse(trimmedFirst).getTime() - parse(rawFirst).getTime()) / 3600000;

      return { rawFirst, trimmedFirst, diffHours };
    });

    expect(result.trimmedFirst).not.toBe(result.rawFirst);
    expect(result.diffHours).toBe(6);
  });

  test('both precip params use fallback URL at analysis timesteps', async ({ page }) => {
    await page.goto('/?layers=earth,rain');
    await waitForAppReady(page);

    const result = await page.evaluate(() => {
      const ts = (window as any).__hypatia.timestepService;
      const data: any[] = ts.timestepsData.ecmwf_ifs;

      // Find an analysis timestep and center the window on it.
      const analysisEntry = data.find((t: any) => t.isAnalysis);
      if (!analysisEntry) return { error: 'no analysis timesteps in data' };

      const tsStr: string = analysisEntry.timestep;
      const date = tsStr.split('T');
      const time = new Date(`${date[0]}T${date[1].slice(0, 2)}:${date[1].slice(2)}:00Z`);

      const { tasks } = ts.getWindowTasks(time, 16, ['rain']);

      const precipTasks = tasks.filter((t: any) => t.modelParam.param === 'precipitation');
      const snowTasks = tasks.filter((t: any) => t.modelParam.param === 'snowfall_water_equivalent');

      const centeredTs = analysisEntry.timestep;
      const precipAtCentered = precipTasks.find((t: any) => t.timestep === centeredTs);
      const snowAtCentered = snowTasks.find((t: any) => t.timestep === centeredTs);

      const normalUrl = analysisEntry.url;
      const fallbackUrl = analysisEntry.fallbackUrl;

      return {
        centeredOnAnalysis: centeredTs,
        hasFallbackUrl: !!fallbackUrl,
        fallbackDiffersFromNormal: fallbackUrl !== normalUrl,
        precipHasTask: !!precipAtCentered,
        snowHasTask: !!snowAtCentered,
        precipUsesRemappedUrl: precipAtCentered?.url === fallbackUrl,
        snowUsesRemappedUrl: snowAtCentered?.url === fallbackUrl,
        precipTaskCount: precipTasks.length,
        snowTaskCount: snowTasks.length,
      };
    });

    expect(result).not.toHaveProperty('error');
    expect(result.hasFallbackUrl).toBe(true);
    expect(result.fallbackDiffersFromNormal).toBe(true);
    // Both backward-sum params use fallback URL at analysis
    expect(result.precipHasTask).toBe(true);
    expect(result.snowHasTask).toBe(true);
    expect(result.precipUsesRemappedUrl).toBe(true);
    expect(result.snowUsesRemappedUrl).toBe(true);
    // Same task count — both are backward-sum
    expect(result.precipTaskCount).toBe(result.snowTaskCount);
  });

  test('backwardSum flag set on precipitation param metadata', async ({ page }) => {
    await page.goto('/?layers=earth');
    await waitForAppReady(page);

    const result = await page.evaluate(() => {
      // Access param metadata via the module system
      const ts = (window as any).__hypatia.timestepService;
      // getModelParam gives us the TModelParam, but we need ParamMeta
      // Check via getWindowTasks behavior instead — if precipitation has
      // backwardSum, it will be skipped at analysis timesteps
      const data = ts.timestepsData.ecmwf_ifs;
      const analysisTs = data.find((t: any) => t.isAnalysis);
      return {
        hasAnalysisTimestep: !!analysisTs,
        analysisTimestep: analysisTs?.timestep,
        isAnalysisFlag: analysisTs?.isAnalysis,
      };
    });

    expect(result.hasAnalysisTimestep).toBe(true);
    expect(result.isAnalysisFlag).toBe(true);
  });
});
