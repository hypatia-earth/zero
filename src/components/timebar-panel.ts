/**
 * TimeBarPanel - Time slider at bottom
 *
 * Shows time ticks per weather layer on a canvas:
 * - Grey: available at ECMWF
 * - Layer color (dark): cached in SW
 * - Layer color: loaded in GPU slot
 * - Green: currently interpolated (active pair)
 */

import m from 'mithril';
import { effect } from '@preact/signals-core';
import type { StateService } from '../services/state-service';
import type { SlotService } from '../services/slot-service';
import type { TimestepService } from '../services/timestep-service';
import { getSunDirection } from '../utils/sun-position';

const DEBUG = false;

/** Weather layers in display order (top to bottom) */
const WEATHER_LAYERS = ['temp', 'rain'] as const;
type WeatherLayer = typeof WEATHER_LAYERS[number];

/** Layer colors (full brightness for GPU, 50% for cached) */
const LAYER_COLORS: Record<WeatherLayer, { gpu: string; cached: string }> = {
  temp: { gpu: '#ff6b35', cached: '#803518' },  // Orange
  rain: { gpu: '#4a90d9', cached: '#25486c' },  // Blue
};

/** Tick colors */
const COLOR_ECMWF = '#444';     // Grey: available at ECMWF
const COLOR_ACTIVE = '#0f0';    // Green: interpolated pair
const COLOR_NOW = 'rgba(255,255,255,0.7)';  // Now marker

/** Tick dimensions */
const TICK_WIDTH = 2;
const TICK_HEIGHT_RATIO = 0.9;  // 90% of row height
const NOW_MARKER_WIDTH = 3;

/** Knob dimensions */
const KNOB_COLOR = 'rgba(255,255,255,0.9)';
const KNOB_LINE_WIDTH = 1.5;
const KNOB_TICK_LENGTH = 6;  // Length of center tick marks

/** Disk perspective warp - compresses edges, expands center */
function diskWarp(t: number): number {
  return (1 - Math.cos(t * Math.PI)) / 2;
}

/** Inverse of diskWarp - converts screen position to linear time */
function diskUnwarp(x: number): number {
  // Solve: x = (1 - cos(t * π)) / 2
  // 2x = 1 - cos(t * π)
  // cos(t * π) = 1 - 2x
  // t = acos(1 - 2x) / π
  const clamped = Math.max(0, Math.min(1, x));
  return Math.acos(1 - 2 * clamped) / Math.PI;
}

/** Disk height factor - taller in center, shorter at edges */
const DISK_MIN_HEIGHT = 0.5;  // Minimum height at edges (50%)
function diskHeight(t: number): number {
  return DISK_MIN_HEIGHT + (1 - DISK_MIN_HEIGHT) * Math.sin(t * Math.PI);
}

/** Calculate sun brightness for a point on globe at given time
 *  Returns 0.5 (night) to 1.0 (day) */
function getSunBrightness(lat: number, lon: number, time: Date): number {
  const sunDir = getSunDirection(time);
  // Convert lat/lon to unit vector (look-at point on globe)
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  const lookAt = [
    Math.cos(latRad) * Math.sin(lonRad),
    Math.sin(latRad),
    Math.cos(latRad) * Math.cos(lonRad),
  ];
  // Dot product: -1 (midnight) to +1 (noon)
  const sunDot = sunDir[0]! * lookAt[0]! + sunDir[1]! * lookAt[1]! + sunDir[2]! * lookAt[2]!;
  // Map to 0.5-1.0 range
  return 0.75 + sunDot * 0.25;
}

interface TimeBarPanelAttrs {
  stateService: StateService;
  slotService: SlotService;
  timestepService: TimestepService;
}


/** Draw ticks and knob on canvas */
function drawTimebar(
  canvas: HTMLCanvasElement,
  window: { start: Date; end: Date },
  activeLayers: WeatherLayer[],
  ecmwfSet: Set<string>,
  cachedMap: Map<WeatherLayer, Set<string>>,
  gpuMap: Map<WeatherLayer, Set<string>>,
  activeMap: Map<WeatherLayer, Set<string>>,
  nowTime: Date,
  currentProgress: number,  // 0-1 linear progress
  cameraLat: number,
  cameraLon: number,
  sunEnabled: boolean
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

  // Calculate linear position 0-1 for a timestamp
  const getT = (ts: string): number => {
    const time = new Date(ts).getTime();
    return (time - window.start.getTime()) / windowMs;
  };

  // Calculate x position with disk warp
  const getX = (t: number): number => diskWarp(t) * width;

  // Height per layer row
  const layerCount = activeLayers.length || 1;
  const layerHeight = height / layerCount;

  // Base tick height
  const baseTickHeight = layerHeight * TICK_HEIGHT_RATIO;

  // Draw ticks for each layer
  activeLayers.forEach((layer, rowIndex) => {
    const cached = cachedMap.get(layer) || new Set();
    const gpu = gpuMap.get(layer) || new Set();
    const active = activeMap.get(layer) || new Set();
    const colors = LAYER_COLORS[layer];
    const rowTopY = rowIndex * layerHeight;

    // Draw each ECMWF timestep
    ecmwfSet.forEach(tsKey => {
      const t = getT(tsKey);
      if (t < 0 || t > 1) return;

      const x = getX(t);
      const tickHeight = baseTickHeight * diskHeight(t);
      const topY = rowTopY + (layerHeight - tickHeight) / 2;  // Center vertically

      // Determine color: green (active) > layer (gpu) > layer dark (cached) > grey (ecmwf)
      let color = COLOR_ECMWF;
      if (cached.has(tsKey)) {
        color = colors.cached;
      }
      if (gpu.has(tsKey)) {
        color = colors.gpu;
      }
      if (active.has(tsKey)) {
        color = COLOR_ACTIVE;
      }

      // Apply sun brightness if enabled
      if (sunEnabled) {
        const brightness = getSunBrightness(cameraLat, cameraLon, new Date(tsKey));
        ctx.globalAlpha = brightness;
      }

      ctx.fillStyle = color;
      ctx.fillRect(x - TICK_WIDTH / 2, topY, TICK_WIDTH, tickHeight);
      ctx.globalAlpha = 1.0;
    });
  });

  // Draw now marker (full height)
  const nowT = getT(nowTime.toISOString());
  const nowX = getX(nowT);
  if (nowT >= 0 && nowT <= 1) {
    ctx.fillStyle = COLOR_NOW;
    ctx.fillRect(nowX - NOW_MARKER_WIDTH / 2, 0, NOW_MARKER_WIDTH, height);
  }

  // Draw knob - square outline with center tick marks
  const knobX = diskWarp(currentProgress) * width;
  const knobSize = height;  // Square: height × height
  const knobLeft = knobX - knobSize / 2;
  const knobTop = 0;

  ctx.strokeStyle = KNOB_COLOR;
  ctx.lineWidth = KNOB_LINE_WIDTH;

  // Square outline
  ctx.strokeRect(knobLeft, knobTop, knobSize, knobSize);

  // Top center tick (pointing down)
  ctx.beginPath();
  ctx.moveTo(knobX, knobTop);
  ctx.lineTo(knobX, knobTop + KNOB_TICK_LENGTH);
  ctx.stroke();

  // Bottom center tick (pointing up)
  ctx.beginPath();
  ctx.moveTo(knobX, knobTop + knobSize);
  ctx.lineTo(knobX, knobTop + knobSize - KNOB_TICK_LENGTH);
  ctx.stroke();
}

export const TimeBarPanel: m.ClosureComponent<TimeBarPanelAttrs> = (initialVnode) => {
  let unsubscribe: (() => void) | null = null;
  let canvasRef: HTMLCanvasElement | null = null;
  let isDragging = false;

  return {
    oncreate() {
      unsubscribe = effect(() => {
        initialVnode.attrs.stateService.state.value;
        initialVnode.attrs.slotService.slotsVersion.value;
        initialVnode.attrs.timestepService.state.value;
        m.redraw();
      });
    },

    onremove() {
      unsubscribe?.();
    },

    view({ attrs }) {
    const { stateService, slotService, timestepService } = attrs;
    const currentTime = stateService.getTime();
    const window = {
      start: timestepService.toDate(timestepService.first()),
      end: timestepService.toDate(timestepService.last()),
    };

    const windowMs = window.end.getTime() - window.start.getTime();
    const currentMs = currentTime.getTime() - window.start.getTime();
    const progress = Math.max(0, Math.min(1, currentMs / windowMs));

    /** Convert mouse x position to time using disk unwarp */
    const mouseToTime = (e: MouseEvent): Date => {
      const rect = canvasRef!.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;  // 0-1 screen position
      const t = diskUnwarp(x);  // 0-1 linear time
      return new Date(window.start.getTime() + t * windowMs);
    };

    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      stateService.setTime(mouseToTime(e));
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      stateService.setTime(mouseToTime(e));
    };

    const handleMouseUp = () => {
      isDragging = false;
    };

    const handleMouseLeave = () => {
      isDragging = false;
    };

    const formatDate = (date: Date) => {
      return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
    };

    // Build ECMWF set (ISO strings for comparison)
    const tsState = timestepService.state.value;
    const ecmwfSet = new Set<string>();
    for (const ts of tsState.ecmwf) {
      ecmwfSet.add(timestepService.toDate(ts).toISOString());
    }

    // Build cached, GPU, and active maps per layer
    const cachedMap = new Map<WeatherLayer, Set<string>>();
    const gpuMap = new Map<WeatherLayer, Set<string>>();
    const activeMap = new Map<WeatherLayer, Set<string>>();

    for (const layer of WEATHER_LAYERS) {
      const paramState = tsState.params.get(layer);

      // Cached in SW
      const cachedSet = new Set<string>();
      if (paramState) {
        for (const ts of paramState.cache) {
          cachedSet.add(timestepService.toDate(ts).toISOString());
        }
      }
      cachedMap.set(layer, cachedSet);

      // GPU loaded
      const gpuSet = new Set<string>();
      const loadedTimesteps = slotService.getLoadedTimestamps(layer);
      for (const ts of loadedTimesteps) {
        gpuSet.add(timestepService.toDate(ts).toISOString());
      }
      gpuMap.set(layer, gpuSet);

      // Active pair
      const activeSet = new Set<string>();
      const activePair = slotService.getActivePair(layer);
      if (activePair) {
        activeSet.add(timestepService.toDate(activePair.t0).toISOString());
        activeSet.add(timestepService.toDate(activePair.t1).toISOString());
      }
      activeMap.set(layer, activeSet);
    }

    DEBUG && console.log(`[Timebar] ECMWF: ${ecmwfSet.size}, cache temp: ${cachedMap.get('temp')?.size}, GPU temp: ${gpuMap.get('temp')?.size}`);

    // Filter to only active weather layers
    const activeLayers = stateService.getLayers();
    const activeWeatherLayers = WEATHER_LAYERS.filter(l => activeLayers.includes(l));

    // Get camera position and sun state for brightness calculation
    const camera = stateService.getCamera();
    const sunEnabled = activeLayers.includes('sun');

    return m('.panel.timebar', [
      m('.control.timeslider', { style: 'width: 100%; height: 42px; position: relative;' }, [
        // Canvas for ticks and knob - acts as custom slider
        m('.time-ticks', [
          m('canvas.time-ticks-canvas', {
            style: 'width: 100%; height: 100%; cursor: pointer;',
            onmousedown: handleMouseDown,
            onmousemove: handleMouseMove,
            onmouseup: handleMouseUp,
            onmouseleave: handleMouseLeave,
            oncreate: (vnode: m.VnodeDOM) => {
              canvasRef = vnode.dom as HTMLCanvasElement;
              drawTimebar(
                canvasRef,
                window,
                activeWeatherLayers,
                ecmwfSet,
                cachedMap,
                gpuMap,
                activeMap,
                new Date(),
                progress,
                camera.lat,
                camera.lon,
                sunEnabled
              );
            },
            onupdate: (vnode: m.VnodeDOM) => {
              canvasRef = vnode.dom as HTMLCanvasElement;
              drawTimebar(
                canvasRef,
                window,
                activeWeatherLayers,
                ecmwfSet,
                cachedMap,
                gpuMap,
                activeMap,
                new Date(),
                progress,
                camera.lat,
                camera.lon,
                sunEnabled
              );
            },
          }),
        ]),
      ]),
      m('.timesteps', { style: 'display: flex; justify-content: space-between; width: 100%; padding: 0 24px; font-size: 12px; opacity: 0.6;' }, [
        m('span', formatDate(window.start)),
        m('span', 'NOW'),
        m('span', formatDate(window.end)),
      ]),
    ]);
    },
  };
};
