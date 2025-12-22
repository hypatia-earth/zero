/**
 * ThemeService - CSS custom property access for TypeScript
 *
 * Reads theme colors from CSS once at init, caches for canvas/WebGPU use.
 * Single source of truth: styles/theme.css
 */

import { WEATHER_LAYERS, type TWeatherLayer } from '../config/types';

export interface LayerColors {
  color: string;  // Full brightness (GPU loaded)
  dim: string;    // 50% brightness (SW cached)
}

export interface TimebarColors {
  ecmwf: string;   // Grey: available at ECMWF
  active: string;  // Green: currently interpolated
  now: string;     // White: now marker
}

export class ThemeService {
  readonly layers: Record<TWeatherLayer, LayerColors> = {} as Record<TWeatherLayer, LayerColors>;
  readonly timebar: TimebarColors = {} as TimebarColors;

  constructor() {
    const style = getComputedStyle(document.documentElement);

    // Read layer colors
    for (const layer of WEATHER_LAYERS) {
      this.layers[layer] = {
        color: style.getPropertyValue(`--color-layer-${layer}`).trim(),
        dim: style.getPropertyValue(`--color-layer-${layer}-dim`).trim(),
      };
    }

    // Read timebar UI colors
    this.timebar.ecmwf = style.getPropertyValue('--color-timebar-ecmwf').trim();
    this.timebar.active = style.getPropertyValue('--color-timebar-active').trim();
    this.timebar.now = style.getPropertyValue('--color-timebar-now').trim();

    console.log('[Theme] Loaded layer colors:', Object.keys(this.layers).length);
  }
}
