/**
 * TimeBarPanel - Time slider at bottom
 *
 * Shows time ticks per weather layer:
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

let unsubscribe: (() => void) | null = null;
let cacheUpdateInterval: ReturnType<typeof setInterval> | null = null;

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

    // Get slot data for temp layer (only temp has BudgetService currently)
    const loadedTimestamps = budgetService.getLoadedTimestamps();
    const loadedSet = new Set(loadedTimestamps.map(ts => ts.toISOString()));
    const activePair = budgetService.getActivePair();
    const activeSet = new Set<string>();
    if (activePair) {
      activeSet.add(activePair.t0.toISOString());
      activeSet.add(activePair.t1.toISOString());
    }

    DEBUG && console.log(`[Timebar] Loaded: ${loadedTimestamps.length}, active: ${activePair ? 'yes' : 'no'}`);

    // Calculate position for a timestamp
    const getPosition = (ts: Date | string) => {
      const time = typeof ts === 'string' ? new Date(ts).getTime() : ts.getTime();
      return ((time - window.start.getTime()) / windowMs) * 100;
    };

    // Filter to only active weather layers
    const activeLayers = stateService.getLayers();
    const activeWeatherLayers = WEATHER_LAYERS.filter(l => activeLayers.includes(l));

    // Height per layer row (50% each for 2 layers, 100% for 1)
    const layerHeight = activeWeatherLayers.length > 0 ? 100 / activeWeatherLayers.length : 100;

    // Build tick elements for each layer
    const renderLayerTicks = (layer: WeatherLayer, rowIndex: number) => {
      const cached = cachedTimestamps.value.get(layer) || new Set();
      const topPercent = rowIndex * layerHeight;

      // Collect all timestamps for this layer
      const allTimestamps = new Set<string>(cached);

      // For temp, also add loaded slots
      if (layer === 'temp') {
        loadedTimestamps.forEach(ts => allTimestamps.add(ts.toISOString()));
      }

      return [...allTimestamps].map(tsKey => {
        const pos = getPosition(tsKey);
        if (pos < 0 || pos > 100) return null;

        // Determine color: green (active) > red (loaded) > grey (cached)
        let color = '#666';  // Grey: only cached in SW
        if (layer === 'temp') {
          if (activeSet.has(tsKey)) {
            color = '#0f0';  // Green: active pair
          } else if (loadedSet.has(tsKey)) {
            color = '#f00';  // Red: loaded in GPU slot
          }
        }

        return m('.time-tick', {
          key: `${layer}-${tsKey}`,
          style: `left: ${pos}%; top: ${topPercent}%; height: ${layerHeight}%; background: ${color};`,
        });
      }).filter((v): v is m.Vnode => v !== null);
    };

    return m('.panel.timebar', [
      m('.control.timeslider', { style: 'width: 100%; height: 42px; position: relative;' }, [
        // Track background with layer ticks
        m('.time-ticks', [
          // Render ticks for each active weather layer
          ...activeWeatherLayers.flatMap((layer, idx) => renderLayerTicks(layer, idx)),
          // Now marker (spans full height)
          m('.time-tick.now-marker', {
            key: 'now-marker',
            style: `left: ${getPosition(dateTimeService.getWallTime())}%; background: rgba(255,255,255,0.7); width: 3px; height: 100%; top: 0;`,
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
