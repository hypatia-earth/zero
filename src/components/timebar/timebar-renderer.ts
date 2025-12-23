/**
 * Timebar canvas renderer
 * Draws ticks, labels, now marker, and knob
 */

import type { TWeatherLayer } from '../../config/types';
import type { ThemeService } from '../../services/theme-service';
import { diskWarp, diskHeight, getSunBrightness } from './timebar-math';

/** Tick dimensions */
const TICK_WIDTH = 2;
const TICK_HEIGHT_RATIO = 0.9;
const TICK_TOP_OFFSET = 2;
const NOW_MARKER_WIDTH = 1;

/** Knob dimensions */
const KNOB_LINE_WIDTH = 1.5;
const KNOB_TICK_LENGTH = 6;

/** Label dimensions */
const LABEL_FONT = '12px Inter Light, system-ui, sans-serif';
const LABEL_COLOR = 'rgba(255,255,255,0.7)';
const LABEL_NOW_COLOR = 'rgba(255,255,255,0.9)';
const LABEL_AREA_HEIGHT = 16;
const LABEL_MIN_GAP = 40;

export interface TimebarRenderParams {
  canvas: HTMLCanvasElement;
  window: { start: Date; end: Date };
  activeLayers: TWeatherLayer[];
  ecmwfSet: Set<string>;
  cachedMap: Map<TWeatherLayer, Set<string>>;
  gpuMap: Map<TWeatherLayer, Set<string>>;
  activeMap: Map<TWeatherLayer, Set<string>>;
  wantedSet: Set<string>;
  nowTime: Date;
  cameraLat: number;
  cameraLon: number;
  sunEnabled: boolean;
  themeService: ThemeService;
}

function formatDate(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

export function renderTimebar(params: TimebarRenderParams): void {
  const {
    canvas, window, activeLayers, ecmwfSet, cachedMap, gpuMap, activeMap,
    wantedSet, nowTime, cameraLat, cameraLon, sunEnabled, themeService
  } = params;

  if (ecmwfSet.size === 0) {
    throw new Error('[Timebar] ecmwfSet is empty');
  }

  const ctx = canvas.getContext('2d')!;
  const dpr = globalThis.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const tickHeight = height - LABEL_AREA_HEIGHT;
  const windowMs = window.end.getTime() - window.start.getTime();

  ctx.clearRect(0, 0, width, height);

  const getT = (ts: string): number => {
    const time = new Date(ts).getTime();
    return (time - window.start.getTime()) / windowMs;
  };

  const getX = (t: number): number => diskWarp(t) * width;

  // Draw ticks (upper area)
  drawTicks(ctx, {
    height: tickHeight, activeLayers, ecmwfSet, cachedMap, gpuMap, activeMap,
    getT, getX, cameraLat, cameraLon, sunEnabled, themeService
  });

  // Draw labels (bottom area)
  drawLabels(ctx, {
    height, tickHeight, window, windowMs, nowTime, getX
  });

  // Draw now marker (tick area only)
  const nowT = getT(nowTime.toISOString());
  if (nowT >= 0 && nowT <= 1) {
    const nowX = getX(nowT);
    ctx.fillStyle = themeService.getColor('color-timebar-now').hex;
    ctx.fillRect(nowX - NOW_MARKER_WIDTH / 2, TICK_TOP_OFFSET, NOW_MARKER_WIDTH, tickHeight);
  }

  // Draw knob spanning wanted window
  drawKnob(ctx, { width, height: tickHeight, topOffset: TICK_TOP_OFFSET, ecmwfSet, wantedSet, getT, getX });
}

interface TickParams {
  height: number;
  activeLayers: TWeatherLayer[];
  ecmwfSet: Set<string>;
  cachedMap: Map<TWeatherLayer, Set<string>>;
  gpuMap: Map<TWeatherLayer, Set<string>>;
  activeMap: Map<TWeatherLayer, Set<string>>;
  getT: (ts: string) => number;
  getX: (t: number) => number;
  cameraLat: number;
  cameraLon: number;
  sunEnabled: boolean;
  themeService: ThemeService;
}

function drawTicks(ctx: CanvasRenderingContext2D, params: TickParams): void {
  const {
    height, activeLayers, ecmwfSet, cachedMap, gpuMap, activeMap,
    getT, getX, cameraLat, cameraLon, sunEnabled, themeService
  } = params;

  const layerCount = activeLayers.length || 1;
  const layerHeight = height / layerCount;
  const baseTickHeight = layerHeight * TICK_HEIGHT_RATIO;

  const ecmwfColor = themeService.getColor('color-timebar-ecmwf').hex;
  const activeColor = themeService.getColor('color-timebar-active').hex;

  if (activeLayers.length === 0) {
    // No weather layers: show grey ECMWF ticks
    ecmwfSet.forEach(tsKey => {
      const t = getT(tsKey);
      const x = getX(t);
      const tickHeight = baseTickHeight * diskHeight(t);
      const topY = TICK_TOP_OFFSET + (layerHeight - tickHeight) / 2;

      if (sunEnabled) {
        ctx.globalAlpha = getSunBrightness(cameraLat, cameraLon, new Date(tsKey));
      }
      ctx.fillStyle = ecmwfColor;
      ctx.fillRect(x - TICK_WIDTH / 2, topY, TICK_WIDTH, tickHeight);
      ctx.globalAlpha = 1.0;
    });
  } else {
    // Weather layers active: show layer-colored ticks
    activeLayers.forEach((layer, rowIndex) => {
      const cached = cachedMap.get(layer)!;
      const gpu = gpuMap.get(layer)!;
      const active = activeMap.get(layer)!;
      const layerColor = themeService.getColor(`color-layer-${layer}`).hex;
      const layerDimColor = themeService.getColor(`color-layer-${layer}-dim`).hex;
      const rowTopY = TICK_TOP_OFFSET + rowIndex * layerHeight;

      ecmwfSet.forEach(tsKey => {
        const t = getT(tsKey);
        const x = getX(t);
        const tickHeight = baseTickHeight * diskHeight(t);
        const topY = rowTopY + (layerHeight - tickHeight) / 2;

        let color = ecmwfColor;
        if (cached.has(tsKey)) color = layerDimColor;
        if (gpu.has(tsKey)) color = layerColor;
        if (active.has(tsKey)) color = activeColor;

        if (sunEnabled) {
          ctx.globalAlpha = getSunBrightness(cameraLat, cameraLon, new Date(tsKey));
        }
        ctx.fillStyle = color;
        ctx.fillRect(x - TICK_WIDTH / 2, topY, TICK_WIDTH, tickHeight);
        ctx.globalAlpha = 1.0;
      });
    });
  }
}

interface LabelParams {
  height: number;
  tickHeight: number;
  window: { start: Date; end: Date };
  windowMs: number;
  nowTime: Date;
  getX: (t: number) => number;
}

function drawLabels(ctx: CanvasRenderingContext2D, params: LabelParams): void {
  const { height, window, windowMs, nowTime, getX } = params;

  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  const y = height - LABEL_AREA_HEIGHT / 2;

  // Track occupied x ranges for collision detection (scaled widths)
  const occupied: Array<{ left: number; right: number }> = [];

  const addLabel = (text: string, t: number, x: number, color: string): boolean => {
    const scale = diskHeight(t);
    const metrics = ctx.measureText(text);
    const scaledHalfWidth = (metrics.width * scale) / 2;

    const left = x - scaledHalfWidth;
    const right = x + scaledHalfWidth;

    // Check collision with existing labels
    for (const zone of occupied) {
      if (left < zone.right + LABEL_MIN_GAP * scale && right > zone.left - LABEL_MIN_GAP * scale) {
        return false;
      }
    }

    occupied.push({ left, right });

    // Draw with perspective scale
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
    return true;
  };

  // Start label (t=0)
  addLabel(formatDate(window.start), 0, getX(0), LABEL_COLOR);

  // End label (t=1)
  addLabel(formatDate(window.end), 1, getX(1), LABEL_COLOR);

  // NOW label
  const nowT = (nowTime.getTime() - window.start.getTime()) / windowMs;
  if (nowT >= 0 && nowT <= 1) {
    addLabel('NOW', nowT, getX(nowT), LABEL_NOW_COLOR);
  }

  // Midnight labels (00:00 UTC)
  const midnights: Date[] = [];
  const startDay = new Date(window.start);
  startDay.setUTCHours(0, 0, 0, 0);
  let current = new Date(startDay.getTime() + 24 * 60 * 60 * 1000);

  while (current < window.end) {
    const endDay = new Date(window.end);
    endDay.setUTCHours(0, 0, 0, 0);
    if (current.getTime() !== endDay.getTime()) {
      midnights.push(new Date(current));
    }
    current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
  }

  // Add midnight labels (skip if collides)
  for (const date of midnights) {
    const t = (date.getTime() - window.start.getTime()) / windowMs;
    addLabel(formatDate(date), t, getX(t), LABEL_COLOR);
  }
}

interface KnobParams {
  width: number;
  height: number;
  topOffset: number;
  ecmwfSet: Set<string>;
  wantedSet: Set<string>;
  getT: (ts: string) => number;
  getX: (t: number) => number;
}

function drawKnob(ctx: CanvasRenderingContext2D, params: KnobParams): void {
  const { height, topOffset, ecmwfSet, wantedSet, getT, getX } = params;

  if (wantedSet.size === 0) return;

  // Find wanted window bounds in ecmwf order
  const ecmwfArray = [...ecmwfSet].sort();
  const wantedIndices: number[] = [];
  for (let i = 0; i < ecmwfArray.length; i++) {
    if (wantedSet.has(ecmwfArray[i]!)) {
      wantedIndices.push(i);
    }
  }

  if (wantedIndices.length === 0) return;

  const firstWantedIdx = wantedIndices[0]!;
  const lastWantedIdx = wantedIndices[wantedIndices.length - 1]!;

  // Expand to prev/next timestep, then shrink by 1px
  const leftIdx = Math.max(0, firstWantedIdx - 1);
  const rightIdx = Math.min(ecmwfArray.length - 1, lastWantedIdx + 1);

  const leftX = getX(getT(ecmwfArray[leftIdx]!)) + 1;
  const rightX = getX(getT(ecmwfArray[rightIdx]!)) - 1;

  ctx.lineWidth = KNOB_LINE_WIDTH;

  // Rectangle outline (60% opacity)
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.strokeRect(leftX, topOffset, rightX - leftX, height);

  // Ticks at edges (100% white)
  ctx.strokeStyle = 'rgba(255,255,255,1.0)';

  // Left edge tick
  ctx.beginPath();
  ctx.moveTo(leftX, topOffset);
  ctx.lineTo(leftX, topOffset + KNOB_TICK_LENGTH);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(leftX, topOffset + height);
  ctx.lineTo(leftX, topOffset + height - KNOB_TICK_LENGTH);
  ctx.stroke();

  // Right edge tick
  ctx.beginPath();
  ctx.moveTo(rightX, topOffset);
  ctx.lineTo(rightX, topOffset + KNOB_TICK_LENGTH);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(rightX, topOffset + height);
  ctx.lineTo(rightX, topOffset + height - KNOB_TICK_LENGTH);
  ctx.stroke();
}
