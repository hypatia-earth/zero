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
import { isWeatherLayer, type TWeatherLayer } from '../../config/types';
import type { SlotService } from '../../services/slot-service';
import type { TimestepService } from '../../services/timestep-service';
import type { OptionsService } from '../../services/options-service';
import type { ConfigService } from '../../services/config-service';
import type { ThemeService } from '../../services/theme-service';
import type { StateService } from '../../services/state-service';
import { diskUnwarp } from './timebar-math';
import { renderTimebar } from './timebar-renderer';

interface TimeBarPanelAttrs {
  optionsService: OptionsService;
  stateService: StateService;
  slotService: SlotService;
  timestepService: TimestepService;
  configService: ConfigService;
  themeService: ThemeService;
}

export const TimeBarPanel: m.ClosureComponent<TimeBarPanelAttrs> = (initialVnode) => {
  let unsubscribe: (() => void) | null = null;
  let canvasRef: HTMLCanvasElement | null = null;
  let isDragging = false;

  const onResize = () => m.redraw();

  return {
    oncreate() {
      unsubscribe = effect(() => {
        initialVnode.attrs.optionsService.options.value;
        initialVnode.attrs.slotService.slotsVersion.value;
        initialVnode.attrs.timestepService.state.value;
        m.redraw();
      });
      globalThis.addEventListener('resize', onResize);
    },

    onremove() {
      unsubscribe?.();
      globalThis.removeEventListener('resize', onResize);
    },

    view({ attrs }) {
      const { optionsService, stateService, slotService, timestepService, configService, themeService } = attrs;

      // Derive window
      const window = {
        start: timestepService.toDate(timestepService.first()),
        end: timestepService.toDate(timestepService.last()),
      };
      const windowMs = window.end.getTime() - window.start.getTime();

      // Position to time conversion
      const posToTime = (clientX: number): Date => {
        const rect = canvasRef!.getBoundingClientRect();
        const x = (clientX - rect.left) / rect.width;
        const t = diskUnwarp(x);
        return new Date(window.start.getTime() + t * windowMs);
      };

      // Mouse handlers
      const handleMouseDown = (e: MouseEvent) => {
        isDragging = true;
        stateService.setTime(posToTime(e.clientX));
      };

      const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging) return;
        stateService.setTime(posToTime(e.clientX));
      };

      const handleMouseUp = () => { isDragging = false; };
      const handleMouseLeave = () => { isDragging = false; };

      // Touch handlers
      const handleTouchStart = (e: TouchEvent) => {
        isDragging = true;
        stateService.setTime(posToTime(e.touches[0]!.clientX));
      };

      const handleTouchMove = (e: TouchEvent) => {
        if (!isDragging) return;
        e.preventDefault();
        stateService.setTime(posToTime(e.touches[0]!.clientX));
      };

      const handleTouchEnd = () => { isDragging = false; };

      // Build data maps
      const tsState = timestepService.state.value;
      const ecmwfSet = new Set<string>();
      for (const ts of tsState.ecmwf) {
        ecmwfSet.add(timestepService.toDate(ts).toISOString());
      }

      const readyWeatherLayers = configService.getReadyLayers().filter(isWeatherLayer);
      const cachedMap = new Map<TWeatherLayer, Set<string>>();
      const gpuMap = new Map<TWeatherLayer, Set<string>>();
      const activeMap = new Map<TWeatherLayer, Set<string>>();

      for (const layer of readyWeatherLayers) {
        const paramState = tsState.params.get(layer)!;

        const cachedSet = new Set<string>();
        for (const ts of paramState.cache) {
          cachedSet.add(timestepService.toDate(ts).toISOString());
        }
        cachedMap.set(layer, cachedSet);

        const gpuSet = new Set<string>();
        for (const ts of paramState.gpu) {
          gpuSet.add(timestepService.toDate(ts).toISOString());
        }
        gpuMap.set(layer, gpuSet);

        const activeSet = new Set<string>();
        for (const ts of slotService.getActiveTimesteps(layer)) {
          activeSet.add(timestepService.toDate(ts).toISOString());
        }
        activeMap.set(layer, activeSet);
      }

      // Filter to enabled layers
      const opts = optionsService.options.value;
      const activeLayers = readyWeatherLayers.filter(layer => opts[layer].enabled);

      // Camera and sun state
      const viewState = stateService.viewState.value;
      const sunEnabled = opts.sun.enabled;

      // Get wanted window for knob rendering
      const wantedWindow = slotService.getWantedWindow();
      const wantedSet = new Set<string>();
      for (const ts of wantedWindow) {
        wantedSet.add(timestepService.toDate(ts).toISOString());
      }

      // Render function for canvas
      const render = (canvas: HTMLCanvasElement) => {
        canvasRef = canvas;
        renderTimebar({
          canvas,
          window,
          activeLayers,
          ecmwfSet,
          cachedMap,
          gpuMap,
          activeMap,
          wantedSet,
          nowTime: new Date(),
          cameraLat: viewState.lat,
          cameraLon: viewState.lon,
          sunEnabled,
          themeService,
        });
      };

      return m('.panel.timebar', [
        m('.control.timeslider', [
          m('canvas.time-ticks', {
            onmousedown: handleMouseDown,
            onmousemove: handleMouseMove,
            onmouseup: handleMouseUp,
            onmouseleave: handleMouseLeave,
            ontouchstart: handleTouchStart,
            ontouchmove: handleTouchMove,
            ontouchend: handleTouchEnd,
            oncreate: (vnode: m.VnodeDOM) => render(vnode.dom as HTMLCanvasElement),
            onupdate: (vnode: m.VnodeDOM) => render(vnode.dom as HTMLCanvasElement),
          }),
        ]),
      ]);
    },
  };
};
