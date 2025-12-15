/**
 * StateService - URL state management
 *
 * URL Format: ?dt=2025-12-09T14:00&ll=35.6,139.7&alt=20000000&layers=temp,rain
 */

import { signal, effect } from '@preact/signals-core';
import type { LayerId } from '../config/types';
import type { ConfigService } from './config-service';

export interface UrlState {
  time: Date;
  lat: number;
  lon: number;
  altitude: number;
  layers: LayerId[];
}

// ============================================================
// URL Parsing
// ============================================================

function formatDateForUrl(date: Date): string {
  return date.toISOString().slice(0, 16).replace(':', 'h') + 'z';
}

function parseDateFromUrl(dt: string): Date | null {
  // Format: 2025-12-09T14h00z
  const normalized = dt.replace('h', ':').replace('z', ':00.000Z');
  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date;
}

function parseUrl(): Partial<UrlState> {
  const params = new URLSearchParams(window.location.search);
  const partial: Partial<UrlState> = {};

  const dt = params.get('dt');
  if (dt) {
    const time = parseDateFromUrl(dt);
    if (time) partial.time = time;
  }

  const ll = params.get('ll');
  if (ll) {
    const [latStr, lonStr] = ll.split(',');
    const lat = parseFloat(latStr ?? '');
    const lon = parseFloat(lonStr ?? '');
    if (!isNaN(lat) && !isNaN(lon)) {
      partial.lat = Math.max(-90, Math.min(90, lat));
      partial.lon = ((lon + 180) % 360) - 180; // Normalize to -180..180
    }
  }

  const alt = params.get('alt');
  if (alt) {
    const altitude = parseFloat(alt);
    if (!isNaN(altitude) && altitude > 0) {
      partial.altitude = altitude;
    }
  }

  const layersStr = params.get('layers');
  if (layersStr) {
    partial.layers = layersStr.split(',').filter(l => l.length > 0) as LayerId[];
  }

  return partial;
}

function writeUrl(state: UrlState): void {
  // Build URL manually to avoid encoding commas
  const dt = formatDateForUrl(state.time);
  const ll = `${state.lat.toFixed(1)},${state.lon.toFixed(1)}`;
  const alt = Math.round(state.altitude).toString();
  let search = `?dt=${dt}&ll=${ll}&alt=${alt}`;
  if (state.layers.length > 0) {
    search += `&layers=${state.layers.join(',')}`;
  }
  window.history.replaceState(null, '', search);
}

// ============================================================
// StateService
// ============================================================

export class StateService {
  readonly state = signal<UrlState>({
    time: new Date(),
    lat: 0,
    lon: 0,
    altitude: 20_000_000,
    layers: [],
  });

  private syncEnabled = false;
  private syncTimer: number | null = null;

  constructor(private configService: ConfigService) {
    const parsed = parseUrl();

    this.state.value = {
      time: parsed.time ?? new Date(),
      lat: parsed.lat ?? 0,
      lon: parsed.lon ?? 0,
      altitude: parsed.altitude ?? 20_000_000,
      layers: parsed.layers ?? this.configService.getDefaultLayers(),
    };

    // Write initial state to URL
    writeUrl(this.state.value);

    // Auto-sync to URL (debounced)
    effect(() => {
      const current = this.state.value;
      if (!this.syncEnabled) return;
      if (this.syncTimer !== null) clearTimeout(this.syncTimer);
      this.syncTimer = window.setTimeout(() => {
        writeUrl(current);
        this.syncTimer = null;
      }, 100);
    });
  }

  enableSync(): void {
    this.syncEnabled = true;
  }

  get(): UrlState {
    return this.state.value;
  }

  getTime(): Date {
    return this.state.value.time;
  }

  setTime(time: Date): void {
    this.state.value = { ...this.state.value, time };
  }

  getCamera(): { lat: number; lon: number; altitude: number } {
    const { lat, lon, altitude } = this.state.value;
    return { lat, lon, altitude };
  }

  setCamera(lat: number, lon: number, altitude: number): void {
    this.state.value = { ...this.state.value, lat, lon, altitude };
  }

  getLayers(): LayerId[] {
    return this.state.value.layers;
  }

  setLayers(layers: LayerId[]): void {
    this.state.value = { ...this.state.value, layers };
  }

  toggleLayer(layerId: LayerId): void {
    const current = this.state.value.layers;
    const layers = current.includes(layerId)
      ? current.filter(l => l !== layerId)
      : [...current, layerId];
    this.state.value = { ...this.state.value, layers };
  }
}
