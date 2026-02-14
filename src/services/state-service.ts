/**
 * StateService - View state and URL management
 *
 * Owns viewState (time, lat, lon, altitude) and all URL parameters.
 * Delegates layer enables to OptionsService.
 * Single entry point for time changes with logging.
 */

import { signal, effect } from '@preact/signals-core';
import { debounceFlush } from '../utils/debounce-flush';
import type { OptionsService } from './options-service';
import type { ConfigService } from './config-service';
import type { LayerService } from './layer/layer-service';

const DEBUG = false;

/** Format time as MM-DD:HH-MM for logging */
const fmtTime = (d: Date) =>
  `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}:${String(d.getUTCHours()).padStart(2, '0')}-${String(d.getUTCMinutes()).padStart(2, '0')}`;

export interface ViewState {
  time: Date;
  lat: number;
  lon: number;
  altitude: number;
}

const DEFAULT_VIEW_STATE: ViewState = {
  time: new Date(),
  lat: 0,
  lon: 0,
  altitude: 14_000,
};

export class StateService {
  readonly viewState = signal<ViewState>({ ...DEFAULT_VIEW_STATE });
  readonly minimalUI = signal(false);

  private urlSyncEnabled = false;
  private debouncedUrlSync = debounceFlush(() => this.syncToUrl(), 300);

  private optionsService: OptionsService;

  /** Post-construction wiring for LayerService (needed for URL sync on custom layer toggle) */
  setLayerService(layerService: LayerService): void {
    // Watch layer registry changes (custom layer enable/disable)
    effect(() => {
      layerService.changed.value;
      this.scheduleUrlSync();
    });
  }

  constructor(
    private configService: ConfigService,
    optionsService: OptionsService
  ) {
    this.optionsService = optionsService;
    this.parseUrl();

    // Effect-based decoupling: watch options and sync URL when they change
    effect(() => {
      this.optionsService.options.value;  // subscribe to options changes
      this.scheduleUrlSync();
    });

    // Flush URL sync before page unload
    window.addEventListener('beforeunload', () => this.debouncedUrlSync.flush());

    // Flush when page becomes hidden (more reliable in Safari)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.debouncedUrlSync.flush();
    });
  }

  /**
   * Set time - single entry point for all time changes
   * Logs [TimeEvent] and schedules URL sync
   */
  setTime(newTime: Date): void {
    const oldTime = this.viewState.value.time;
    if (oldTime.getTime() === newTime.getTime()) return;

    DEBUG && console.log(`[TimeEvent] ${fmtTime(oldTime)} => ${fmtTime(newTime)}`);
    this.viewState.value = { ...this.viewState.value, time: newTime };
    this.scheduleUrlSync();
  }

  /**
   * Set position (lat, lon, altitude)
   */
  setPosition(lat: number, lon: number, altitude: number): void {
    const vs = this.viewState.value;
    if (vs.lat === lat && vs.lon === lon && vs.altitude === altitude) return;

    this.viewState.value = { ...this.viewState.value, lat, lon, altitude };
    this.scheduleUrlSync();
  }

  /** Toggle minimal UI mode (hide all panels except logo and timecircle) */
  toggleMinimalUI(): void {
    this.minimalUI.value = !this.minimalUI.value;
  }

  /**
   * Sanitize viewState after TimestepService ready
   * - Snaps time to closest available timestep
   * - Clamps lat/lon/altitude
   */
  sanitize(getClosestTimestep: (time: Date) => Date): void {
    const vs = this.viewState.value;
    const changes: string[] = [];

    // Snap time to closest available timestep
    const snappedTime = getClosestTimestep(vs.time);
    let newTime = vs.time;
    if (snappedTime.getTime() !== vs.time.getTime()) {
      newTime = snappedTime;
      changes.push(`time=${fmtTime(vs.time)}=>${fmtTime(snappedTime)}`);
    }

    // Log changes
    const params = new URLSearchParams(window.location.search);
    const llParam = params.get('ll');
    if (!llParam) {
      changes.push(`lat=${vs.lat.toFixed(1)}, lon=${vs.lon.toFixed(1)}`);
    }
    const altParam = params.get('alt');
    if (!altParam) {
      changes.push(`alt=${vs.altitude}`);
    }

    if (changes.length) {
    }

    // Update state (without triggering URL sync yet)
    if (newTime !== vs.time) {
      this.viewState.value = { ...this.viewState.value, time: newTime };
    }

    // Schedule URL sync (will only run after enableUrlSync is called)
    this.scheduleUrlSync();
  }

  /** Enable URL sync after bootstrap complete */
  enableUrlSync(): void {
    this.urlSyncEnabled = true;
  }

  // ============================================================
  // URL Parsing
  // ============================================================

  private parseUrl(): void {
    const params = new URLSearchParams(window.location.search);
    const vs = { ...DEFAULT_VIEW_STATE };

    // Parse dt (time)
    const dt = params.get('dt');
    if (dt) {
      const time = this.parseDateFromUrl(dt);
      if (time) vs.time = time;
    }

    // Parse ll (lat,lon)
    const ll = params.get('ll');
    if (ll) {
      const [latStr, lonStr] = ll.split(',');
      const lat = parseFloat(latStr ?? '');
      const lon = parseFloat(lonStr ?? '');
      if (!isNaN(lat) && !isNaN(lon)) {
        vs.lat = Math.max(-90, Math.min(90, lat));
        vs.lon = ((lon + 180) % 360) - 180;
      }
    }

    // Parse alt (altitude)
    const alt = params.get('alt');
    if (alt) {
      const altitude = parseFloat(alt);
      if (!isNaN(altitude)) {
        vs.altitude = Math.max(300, Math.min(36_000, altitude));
      }
    }

    this.viewState.value = vs;

    // Delegate layers to OptionsService (done later via delegateLayers)
  }

  /**
   * Parse layers from URL and delegate to OptionsService
   * Call after OptionsService is wired up
   */
  delegateLayers(): void {

    const params = new URLSearchParams(window.location.search);
    const layersStr = params.get('layers');

    // If no layers param, use config defaults
    const enabledLayers = layersStr !== null
      ? new Set(layersStr.split(',').filter(l => l.length > 0))
      : new Set(this.configService.getDefaultLayers());

    // Delegate to OptionsService
    this.optionsService.setEnabledLayers(enabledLayers);
  }

  private parseDateFromUrl(dt: string): Date | null {
    const normalized = dt.replace('h', ':').replace('z', ':00.000Z');
    const date = new Date(normalized);
    return isNaN(date.getTime()) ? null : date;
  }

  // ============================================================
  // URL Sync
  // ============================================================

  /** Schedule URL sync (debounced). Called by OptionsService when layers change. */
  scheduleUrlSync(): void {
    if (!this.urlSyncEnabled) return;
    this.debouncedUrlSync();
  }

  private syncToUrl(): void {
    const vs = this.viewState.value;

    // Build viewState params
    const dt = this.formatDateForUrl(vs.time);
    const ll = `${vs.lat.toFixed(1)},${vs.lon.toFixed(1)}`;
    const alt = Math.round(vs.altitude).toString();

    // Get enabled layers from OptionsService
    const enabledLayers = this.optionsService.getEnabledLayers();

    // Build URL manually to keep commas unencoded
    let search = `?dt=${dt}&ll=${ll}&alt=${alt}`;
    if (enabledLayers.length > 0) {
      search += `&layers=${enabledLayers.join(',')}`;
    }

    window.history.replaceState(null, '', search);
  }

  private formatDateForUrl(date: Date): string {
    return date.toISOString().slice(0, 16).replace(':', 'h') + 'z';
  }
}
