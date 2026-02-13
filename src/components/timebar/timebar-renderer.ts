/**
 * Timebar canvas renderer
 * Draws ticks, labels, now marker, and knob
 */

import type { TWeatherLayer } from '../../config/types';
import type { ThemeService } from '../../services/theme-service';
import { diskWarp, diskHeight, getSunBrightness } from './timebar-math';

/** Get layout from ThemeService */
function getLayout(themeService: ThemeService) {
  return {
    topPadding: themeService.getSize('size-timebar-top-padding'),
    diskHeight: themeService.getSize('size-timebar-disk-height'),
    diskLabelGap: themeService.getSize('size-timebar-disk-label-gap'),
    labelHeight: themeService.getSize('size-timebar-label-height'),
    bottomPadding: themeService.getSize('size-timebar-bottom-padding'),
  };
}

/** Total timebar height in pixels */
export function getTimebarHeight(themeService: ThemeService): number {
  const L = getLayout(themeService);
  return L.topPadding + L.diskHeight + L.diskLabelGap + L.labelHeight + L.bottomPadding;
}

/** Tick dimensions */
const TICK_WIDTH = 2;
const TICK_HEIGHT_RATIO = 0.9;
const NOW_MARKER_WIDTH = 1;

/** Knob dimensions */
const KNOB_LINE_WIDTH = 1.5;
const KNOB_TICK_LENGTH = 6;

/** Label dimensions */
const LABEL_FONT = '12px Inter Light, system-ui, sans-serif';
const LABEL_COLOR = 'rgba(255,255,255,0.7)';
const LABEL_NOW_COLOR = 'rgba(255,255,255,0.9)';
const LABEL_MIN_GAP = 40;

export interface TimebarRenderParams {
  canvas: HTMLCanvasElement;
  window: { start: Date; end: Date };
  activeLayers: TWeatherLayer[];
  layerParams: Map<TWeatherLayer, string[]>;  // params per layer
  ecmwfSet: Set<string>;
  cachedMap: Map<string, Set<string>>;  // param → cached timesteps
  gpuMap: Map<string, Set<string>>;     // param → gpu timesteps
  activeMap: Map<string, Set<string>>;  // param → active timesteps
  wantedSet: Set<string>;
  nowTime: Date;
  viewTime: Date;
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
    canvas, window, activeLayers, layerParams, ecmwfSet, cachedMap, gpuMap, activeMap,
    wantedSet, nowTime, viewTime, cameraLat, cameraLon, sunEnabled, themeService
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

  // Get layout from CSS vars via themeService
  const L = getLayout(themeService);
  const diskTop = L.topPadding;
  const labelTop = diskTop + L.diskHeight + L.diskLabelGap;
  const windowMs = window.end.getTime() - window.start.getTime();

  ctx.clearRect(0, 0, rect.width, rect.height);

  const getT = (ts: string): number => {
    const time = new Date(ts).getTime();
    return (time - window.start.getTime()) / windowMs;
  };

  const getX = (t: number): number => diskWarp(t) * width;

  // Draw ticks (disk area)
  drawTicks(ctx, {
    diskTop, diskHeight: L.diskHeight, activeLayers, layerParams, ecmwfSet, cachedMap, gpuMap, activeMap,
    getT, getX, cameraLat, cameraLon, sunEnabled, themeService
  });

  // Draw labels (below disk)
  drawLabels(ctx, {
    labelTop, labelHeight: L.labelHeight, window, windowMs, nowTime, getX
  });

  // Draw now marker (disk area only)
  const nowT = getT(nowTime.toISOString());
  if (nowT >= 0 && nowT <= 1) {
    const nowX = getX(nowT);
    ctx.fillStyle = themeService.getColor('color-timebar-now').css;
    ctx.fillRect(nowX - NOW_MARKER_WIDTH / 2, diskTop, NOW_MARKER_WIDTH, L.diskHeight);
  }

  // Draw knob spanning wanted window
  drawKnob(ctx, { diskTop, diskHeight: L.diskHeight, viewTime, ecmwfSet, wantedSet, getT, getX });
}

interface TickParams {
  diskTop: number;
  diskHeight: number;
  activeLayers: TWeatherLayer[];
  layerParams: Map<TWeatherLayer, string[]>;
  ecmwfSet: Set<string>;
  cachedMap: Map<string, Set<string>>;   // param → timesteps
  gpuMap: Map<string, Set<string>>;      // param → timesteps
  activeMap: Map<string, Set<string>>;   // param → timesteps
  getT: (ts: string) => number;
  getX: (t: number) => number;
  cameraLat: number;
  cameraLon: number;
  sunEnabled: boolean;
  themeService: ThemeService;
}

const PARAM_GAP = 1;  // 1px gap between param sub-rows

function drawTicks(ctx: CanvasRenderingContext2D, params: TickParams): void {
  const {
    diskTop, diskHeight: totalDiskHeight, activeLayers, layerParams, ecmwfSet, cachedMap, gpuMap, activeMap,
    getT, getX, cameraLat, cameraLon, sunEnabled, themeService
  } = params;

  const layerCount = activeLayers.length || 1;
  const layerHeight = totalDiskHeight / layerCount;

  const ecmwfColor = themeService.getColor('color-timebar-ecmwf').css;
  const activeColor = themeService.getColor('color-timebar-active').css;

  if (activeLayers.length === 0) {
    // No weather layers: show grey ECMWF ticks
    const baseTickHeight = layerHeight * TICK_HEIGHT_RATIO;
    ecmwfSet.forEach(tsKey => {
      const t = getT(tsKey);
      const x = getX(t);
      const tickH = baseTickHeight * diskHeight(t);
      const topY = diskTop + (layerHeight - tickH) / 2;

      if (sunEnabled) {
        ctx.globalAlpha = getSunBrightness(cameraLat, cameraLon, new Date(tsKey));
      }
      ctx.fillStyle = ecmwfColor;
      ctx.fillRect(x - TICK_WIDTH / 2, topY, TICK_WIDTH, tickH);
      ctx.globalAlpha = 1.0;
    });
  } else {
    // Weather layers active: show layer-colored ticks with param sub-rows
    activeLayers.forEach((layer, layerIndex) => {
      const params = layerParams.get(layer) ?? [];
      const paramCount = params.length || 1;
      const layerColor = themeService.getColor(`color-layer-${layer}`, 1.1, 1.2).css;
      const layerDimColor = themeService.getColor(`color-layer-${layer}`, 0.67, 0.67).css;
      const layerTopY = diskTop + layerIndex * layerHeight;

      // Calculate sub-row height with gaps
      const totalGaps = (paramCount - 1) * PARAM_GAP;
      const paramHeight = (layerHeight - totalGaps) / paramCount;
      const baseTickHeight = paramHeight * TICK_HEIGHT_RATIO;

      params.forEach((param, paramIndex) => {
        const cached = cachedMap.get(param) ?? new Set();
        const gpu = gpuMap.get(param) ?? new Set();
        const active = activeMap.get(param) ?? new Set();
        const paramTopY = layerTopY + paramIndex * (paramHeight + PARAM_GAP);

        ecmwfSet.forEach(tsKey => {
          const t = getT(tsKey);
          const x = getX(t);
          const tickH = baseTickHeight * diskHeight(t);
          const topY = paramTopY + (paramHeight - tickH) / 2;

          let color = ecmwfColor;
          if (cached.has(tsKey)) color = layerDimColor;
          if (gpu.has(tsKey)) color = layerColor;
          if (active.has(tsKey)) color = activeColor;

          if (sunEnabled) {
            ctx.globalAlpha = getSunBrightness(cameraLat, cameraLon, new Date(tsKey));
          }
          ctx.fillStyle = color;
          ctx.fillRect(x - TICK_WIDTH / 2, topY, TICK_WIDTH, tickH);
          ctx.globalAlpha = 1.0;
        });
      });
    });
  }
}

interface LabelParams {
  labelTop: number;
  labelHeight: number;
  window: { start: Date; end: Date };
  windowMs: number;
  nowTime: Date;
  getX: (t: number) => number;
}

function drawLabels(ctx: CanvasRenderingContext2D, params: LabelParams): void {
  const { labelTop, labelHeight, window, windowMs, nowTime, getX } = params;

  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  const y = labelTop + labelHeight / 2;

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
  diskTop: number;
  diskHeight: number;
  viewTime: Date;
  ecmwfSet: Set<string>;
  wantedSet: Set<string>;
  getT: (ts: string) => number;
  getX: (t: number) => number;
}

function drawKnob(ctx: CanvasRenderingContext2D, params: KnobParams): void {
  const { diskTop, diskHeight, viewTime, ecmwfSet, wantedSet, getT, getX } = params;

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

  // Rectangle outline (30% opacity)
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.strokeRect(leftX, diskTop, rightX - leftX, diskHeight);

  // Tick marks at view time position (100% white)
  const viewX = getX(getT(viewTime.toISOString()));
  ctx.strokeStyle = 'rgba(255,255,255,1.0)';

  // Top tick
  ctx.beginPath();
  ctx.moveTo(viewX, diskTop);
  ctx.lineTo(viewX, diskTop + KNOB_TICK_LENGTH);
  ctx.stroke();

  // Bottom tick
  ctx.beginPath();
  ctx.moveTo(viewX, diskTop + diskHeight);
  ctx.lineTo(viewX, diskTop + diskHeight - KNOB_TICK_LENGTH);
  ctx.stroke();
}
