import { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Read a pixel from the WebGPU canvas using Canvas 2D copy.
 * Coordinates are in canvas pixels (CSS pixels * devicePixelRatio).
 */
export async function readPixel(page: Page, x: number, y: number): Promise<Pixel> {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('canvas')!;
    const temp = document.createElement('canvas');
    temp.width = canvas.width;
    temp.height = canvas.height;
    const ctx = temp.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0);
    const p = ctx.getImageData(x, y, 1, 1).data;
    return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3]! };
  }, { x, y });
}

/**
 * Read pixel at center of canvas.
 */
export async function readCenterPixel(page: Page): Promise<Pixel> {
  const { width, height } = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    return { width: canvas.width, height: canvas.height };
  });
  return readPixel(page, Math.floor(width / 2), Math.floor(height / 2));
}

/**
 * Wait for app to be fully loaded (bootstrap complete).
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    return typeof (window as any).__hypatia !== 'undefined';
  }, { timeout: 30000 });
}

/**
 * Wait for a specific layer to have data ready.
 */
export async function waitForLayerReady(page: Page, layer: string): Promise<void> {
  await page.waitForFunction((layer) => {
    const hypatia = (window as any).__hypatia;
    return hypatia?.slotService?.readyLayers?.includes(layer);
  }, layer, { timeout: 30000 });
}

/**
 * Get fixture path for a synthetic OM file.
 */
export function getFixturePath(filename: string): string {
  return path.join(__dirname, '..', 'fixtures', filename);
}

/**
 * Read fixture file as buffer.
 */
export function readFixture(filename: string): Buffer {
  return fs.readFileSync(getFixturePath(filename));
}

/**
 * Set up route to intercept OM file requests and serve synthetic fixture.
 */
export async function interceptOMRequests(page: Page, fixture: string): Promise<void> {
  const fixtureData = readFixture(fixture);
  await page.route('**/*.om', async (route) => {
    await route.fulfill({
      body: fixtureData,
      contentType: 'application/octet-stream',
    });
  });
}
