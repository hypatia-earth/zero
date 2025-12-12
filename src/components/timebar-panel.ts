/**
 * TimeBarPanel - Time slider at bottom
 *
 * Shows time ticks per weather layer on a canvas:
 * - Grey: cached in SW but not loaded to GPU
 * - Red: loaded in GPU slot
 * - Green: currently being rendered (active pair)
 */

import m from 'mithril';
import { effect, signal } from '@preact/signals-core';
import type { StateService } from '../services/state-service';
import type { DateTimeService } from '../services/datetime-service';
import type { BudgetService } from '../services/budget-service';

const DEBUG = false;

/** Weather layers in display order (top to bottom) */
const WEATHER_LAYERS = ['temp', 'rain'] as const;
type WeatherLayer = typeof WEATHER_LAYERS[number];

/** Tick colors */
const COLOR_CACHED = '#666';    // Grey: only cached in SW
const COLOR_LOADED = '#f00';    // Red: loaded in GPU slot
const COLOR_ACTIVE = '#0f0';    // Green: active pair
const COLOR_NOW = 'rgba(255,255,255,0.7)';  // Now marker

/** Tick dimensions */
const TICK_WIDTH = 2;
const NOW_MARKER_WIDTH = 3;

interface TimeBarPanelAttrs {
  stateService: StateService;
  dateTimeService: DateTimeService;
  budgetService: BudgetService;
}

/** Cached timestamps per layer from SW */
const cachedTimestamps = signal<Map<WeatherLayer, Set<string>>>(new Map());

/** Fetch cached timestamps from SW */
async function updateCachedTimestamps(): Promise<void> {
  if (!navigator.serviceWorker.controller) return;

  const newCache = new Map<WeatherLayer, Set<string>>();

  for (const layer of WEATHER_LAYERS) {
    try {
      const result = await new Promise<{ items: Array<{ url: string }> }>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (e) => resolve(e.data);
        navigator.serviceWorker.controller!.postMessage(
          { type: 'GET_LAYER_STATS', layer },
          [channel.port2]
        );
      });

      // Extract timestamps from URLs: ...2025-12-12T14.om?range=... → 2025-12-12T14:00:00.000Z
      const timestamps = new Set<string>();
      DEBUG && result.items.length > 0 && console.log(`[Timebar] Sample URL: ${result.items[0]?.url}`);
      for (const item of result.items) {
        const match = item.url.match(/(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})\.om/);
        if (match) {
          const [, date, hour] = match;
          timestamps.add(`${date}T${hour}:00:00.000Z`);
        }
      }
      DEBUG && console.log(`[Timebar] ${layer}: ${result.items.length} cache entries → ${timestamps.size} unique timesteps`);
      newCache.set(layer, timestamps);
    } catch {
      newCache.set(layer, new Set());
    }
  }

  cachedTimestamps.value = newCache;
}

/** Draw ticks on canvas */
function drawTicks(
  canvas: HTMLCanvasElement,
  window: { start: Date; end: Date },
  activeLayers: WeatherLayer[],
  cachedMap: Map<WeatherLayer, Set<string>>,
  loadedSet: Set<string>,
  activeSet: Set<string>,
  nowTime: Date
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Handle device pixel ratio for crisp rendering
  const dpr = globalThis.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const windowMs = window.end.getTime() - window.start.getTime();

  // Clear
  ctx.clearRect(0, 0, width, height);

  // Calculate position for a timestamp
  const getX = (ts: Date | string): number => {
    const time = typeof ts === 'string' ? new Date(ts).getTime() : ts.getTime();
    return ((time - window.start.getTime()) / windowMs) * width;
  };

  // Height per layer row
  const layerCount = activeLayers.length || 1;
  const layerHeight = height / layerCount;

  // Draw ticks for each layer
  activeLayers.forEach((layer, rowIndex) => {
    const cached = cachedMap.get(layer) || new Set();
    const topY = rowIndex * layerHeight;

    // Collect all timestamps for this layer
    const allTimestamps = new Set<string>(cached);

    // For temp, also add loaded slots
    if (layer === 'temp') {
      loadedSet.forEach(ts => allTimestamps.add(ts));
    }

    // Draw each tick
    allTimestamps.forEach(tsKey => {
      const x = getX(tsKey);
      if (x < 0 || x > width) return;

      // Determine color: green (active) > red (loaded) > grey (cached)
      let color = COLOR_CACHED;
      if (layer === 'temp') {
        if (activeSet.has(tsKey)) {
          color = COLOR_ACTIVE;
        } else if (loadedSet.has(tsKey)) {
          color = COLOR_LOADED;
        }
      }

      ctx.fillStyle = color;
      ctx.fillRect(x - TICK_WIDTH / 2, topY, TICK_WIDTH, layerHeight);
    });
  });

  // Draw now marker (full height)
  const nowX = getX(nowTime);
  if (nowX >= 0 && nowX <= width) {
    ctx.fillStyle = COLOR_NOW;
    ctx.fillRect(nowX - NOW_MARKER_WIDTH / 2, 0, NOW_MARKER_WIDTH, height);
  }
}

let unsubscribe: (() => void) | null = null;
let cacheUpdateInterval: ReturnType<typeof setInterval> | null = null;
let canvasRef: HTMLCanvasElement | null = null;

export const TimeBarPanel: m.Component<TimeBarPanelAttrs> = {
  oncreate({ attrs }) {
    unsubscribe = effect(() => {
      attrs.stateService.state.value;
      attrs.budgetService.slotsVersion.value;
      cachedTimestamps.value;  // Watch cache updates
      m.redraw();
    });

    // Initial fetch and periodic updates
    updateCachedTimestamps();
    cacheUpdateInterval = setInterval(updateCachedTimestamps, 5000);
  },
  onremove() {
    unsubscribe?.();
    unsubscribe = null;
    if (cacheUpdateInterval) {
      clearInterval(cacheUpdateInterval);
      cacheUpdateInterval = null;
    }
    canvasRef = null;
  },
  view({ attrs }) {
    const { stateService, dateTimeService, budgetService } = attrs;
    const currentTime = stateService.getTime();
    const window = dateTimeService.getDataWindow();

    const windowMs = window.end.getTime() - window.start.getTime();
    const currentMs = currentTime.getTime() - window.start.getTime();
    const progress = Math.max(0, Math.min(100, (currentMs / windowMs) * 100));

    const handleInput = (e: Event) => {
      const target = e.target as HTMLInputElement;
      const value = parseFloat(target.value);
      const newTime = new Date(window.start.getTime() + (value / 100) * windowMs);
      stateService.setTime(newTime);
    };

    const formatDate = (date: Date) => {
      return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
    };

    // Get slot data for temp layer
    const loadedTimestamps = budgetService.getLoadedTimestamps();
    const loadedSet = new Set(loadedTimestamps.map(ts => ts.toISOString()));
    const activePair = budgetService.getActivePair();
    const activeSet = new Set<string>();
    if (activePair) {
      activeSet.add(activePair.t0.toISOString());
      activeSet.add(activePair.t1.toISOString());
    }

    DEBUG && console.log(`[Timebar] Loaded: ${loadedTimestamps.length}, active: ${activePair ? 'yes' : 'no'}`);

    // Filter to only active weather layers
    const activeLayers = stateService.getLayers();
    const activeWeatherLayers = WEATHER_LAYERS.filter(l => activeLayers.includes(l));

    return m('.panel.timebar', [
      m('.control.timeslider', { style: 'width: 100%; height: 42px; position: relative;' }, [
        // Canvas for ticks
        m('.time-ticks', [
          m('canvas.time-ticks-canvas', {
            style: 'width: 100%; height: 100%;',
            oncreate: (vnode: m.VnodeDOM) => {
              canvasRef = vnode.dom as HTMLCanvasElement;
              drawTicks(
                canvasRef,
                window,
                activeWeatherLayers,
                cachedTimestamps.value,
                loadedSet,
                activeSet,
                dateTimeService.getWallTime()
              );
            },
            onupdate: (vnode: m.VnodeDOM) => {
              canvasRef = vnode.dom as HTMLCanvasElement;
              drawTicks(
                canvasRef,
                window,
                activeWeatherLayers,
                cachedTimestamps.value,
                loadedSet,
                activeSet,
                dateTimeService.getWallTime()
              );
            },
          }),
        ]),
        // Slider input
        m('input[type=range].timeslider', {
          min: 0,
          max: 100,
          step: 0.1,
          value: progress,
          oninput: handleInput,
        }),
      ]),
      m('.timesteps', { style: 'display: flex; justify-content: space-between; width: 100%; padding: 0 24px; font-size: 12px; opacity: 0.6;' }, [
        m('span', formatDate(window.start)),
        m('span', 'NOW'),
        m('span', formatDate(window.end)),
      ]),
    ]);
  },
};
