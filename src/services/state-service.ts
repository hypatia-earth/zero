/**
 * StateService - View state and URL management
 *
 * Owns viewState (time, lat, lon, altitude) and all URL parameters.
 * Delegates layer enables to OptionsService.
 * Single entry point for time changes with logging.
 */

import { signal, effect } from '@preact/signals-core';
import { debounceFlush } from '../utils/debounce-flush';
import type { ConfigService } from './config-service';
import type { LayerService } from './layer/layer-service';
import type { TimestepService } from './timestep/timestep-service';
import { builtInLayerIds } from '../config/defaults';

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
  /** Canonical set of enabled layer IDs (built-in + custom). URL is the
   *  persistence boundary; F-C made this signal the in-memory truth (was
   *  scattered across `optionsService.options.value.<layer>.enabled` +
   *  LayerService's userLayerEnabled Map). */
  readonly enabledLayers = signal<Set<string>>(new Set());
  readonly minimalUI = signal(false);
  readonly event: string | null = null;

  private urlSyncEnabled = false;
  private hasExplicitDt = false;
  private debouncedUrlSync = debounceFlush(() => this.syncToUrl(), 300);

  private layerService: LayerService | null = null;
  private timestepService: TimestepService | null = null;

  /** Post-construction wiring for TimestepService (needed for time clamping) */
  setTimestepService(timestepService: TimestepService): void {
    this.timestepService = timestepService;
  }

  /** Post-construction wiring for LayerService (needed for layer sanitization) */
  setLayerService(layerService: LayerService): void {
    this.layerService = layerService;
  }

  constructor(
    private configService: ConfigService,
  ) {
    this.event = new URLSearchParams(window.location.search).get('event');
    this.parseUrl();

    // URL sync fires whenever the canonical enabled-set changes.
    effect(() => {
      this.enabledLayers.value;
      this.scheduleUrlSync();
    });

    // Flush URL sync before page unload
    window.addEventListener('beforeunload', () => this.debouncedUrlSync.flush());

    // Flush when page becomes hidden (more reliable in Safari)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.debouncedUrlSync.flush();
    });
  }

  /** Bulk-replace the enabled set (used by sanitize() with URL-derived IDs). */
  applyEnabledLayers(set: Set<string>): void {
    this.enabledLayers.value = new Set(set);
  }

  /** Set a single layer's enabled flag. No-op if value already matches. */
  setLayerEnabled(id: string, value: boolean): void {
    const cur = this.enabledLayers.value;
    if (cur.has(id) === value) return;
    const next = new Set(cur);
    if (value) next.add(id); else next.delete(id);
    this.enabledLayers.value = next;
  }

  /** Toggle a layer; returns the new state. */
  toggleLayer(id: string): boolean {
    const next = !this.enabledLayers.value.has(id);
    this.setLayerEnabled(id, next);
    return next;
  }

  /** Test if a layer is currently enabled. */
  isLayerEnabled(id: string): boolean {
    return this.enabledLayers.value.has(id);
  }

  /**
   * Set time - single entry point for all time changes
   * Logs [TimeEvent] and schedules URL sync
   */
  setTime(newTime: Date): void {
    // Clamp to available timestep range
    let clamped = newTime;
    if (this.timestepService) {
      const firstMs = this.timestepService.toDate(this.timestepService.first()).getTime();
      const lastMs = this.timestepService.toDate(this.timestepService.last()).getTime();
      const ms = Math.max(firstMs, Math.min(lastMs, newTime.getTime()));
      clamped = new Date(ms);
    }

    const oldTime = this.viewState.value.time;
    if (oldTime.getTime() === clamped.getTime()) return;

    DEBUG && console.log(`[TimeEvent] ${fmtTime(oldTime)} => ${fmtTime(clamped)}`);
    this.viewState.value = { ...this.viewState.value, time: clamped };
    this.scheduleUrlSync();
  }

  /**
   * Set position (lat, lon, altitude)
   * Rounds to URL precision (1 decimal for lat/lon, integer for altitude) to prevent
   * continuous micro-changes from physics decay constantly resetting the debounce.
   */
  setPosition(lat: number, lon: number, altitude: number): void {
    // Round to URL precision
    const roundedLat = Math.round(lat * 10) / 10;
    const roundedLon = Math.round(lon * 10) / 10;
    const roundedAlt = Math.round(altitude);

    const vs = this.viewState.value;
    if (vs.lat === roundedLat && vs.lon === roundedLon && vs.altitude === roundedAlt) return;

    this.viewState.value = { ...this.viewState.value, lat: roundedLat, lon: roundedLon, altitude: roundedAlt };
    this.scheduleUrlSync();
  }

  /** Toggle minimal UI mode (hide all panels except logo and timecircle) */
  toggleMinimalUI(): void {
    this.minimalUI.value = !this.minimalUI.value;
  }

  /**
   * Sanitize viewState and layers after TimestepService ready
   * - Snaps time to closest available timestep
   * - Clamps lat/lon/altitude
   * - Validates and applies layer enables from URL
   */
  sanitize(getClosestTimestep: (time: Date) => Date, getMiddleTimestep?: () => Date): void {
    const vs = this.viewState.value;
    const changes: string[] = [];
    const params = new URLSearchParams(window.location.search);

    // For archive events without explicit dt, jump to middle of archive range
    let newTime = vs.time;
    if (this.event && !this.hasExplicitDt && getMiddleTimestep) {
      const middleTime = getMiddleTimestep();
      newTime = middleTime;
      changes.push(`time=archive-mid=>${fmtTime(middleTime)}`);
    } else {
      // Snap time to closest available timestep
      const snappedTime = getClosestTimestep(vs.time);
      if (snappedTime.getTime() !== vs.time.getTime()) {
        newTime = snappedTime;
        changes.push(`time=${fmtTime(vs.time)}=>${fmtTime(snappedTime)}`);
      }
    }

    // Log changes
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

    // Update viewState (without triggering URL sync yet)
    if (newTime !== vs.time) {
      this.viewState.value = { ...this.viewState.value, time: newTime };
    }

    // Sanitize layers: validate and apply from URL
    const layersStr = params.get('layers');
    const customIds = this.layerService!.getAll().filter(l => !l.isBuiltIn).map(l => l.id);
    const validIds = new Set<string>([...builtInLayerIds, ...customIds]);

    let enabledLayers: string[];
    if (layersStr === null || layersStr === '') {
      // No layers param: use defaults
      enabledLayers = [...this.configService.getDefaultLayers()];
    } else {
      // Filter to valid layer IDs only
      enabledLayers = layersStr.split(',').filter(id => validIds.has(id));
    }

    // Apply sanitized layers to state
    this.applyEnabledLayers(new Set(enabledLayers));

    // Write sanitized state to URL
    this.syncToUrl();
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
    this.hasExplicitDt = dt !== null;
    if (dt) {
      const time = this.parseDateFromUrl(dt);
      if (time) vs.time = time;
    }

    // Parse ll (lat,lon)
    const ll = params.get('ll');
    if (ll) {
      const parts = ll.split(',');
      if (parts.length >= 2) {
        const lat = parseFloat(parts[0]!);
        const lon = parseFloat(parts[1]!);
        if (!isNaN(lat) && !isNaN(lon)) {
          vs.lat = Math.max(-90, Math.min(90, lat));
          vs.lon = ((lon + 180) % 360) - 180;
        }
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
    // Note: layer enables are handled by sanitize() after custom layers are loaded
  }

  private parseDateFromUrl(dt: string): Date | null {
    const normalized = dt.replace('h', ':').replace('z', ':00.000Z');
    const date = new Date(normalized);
    return isNaN(date.getTime()) ? null : date;
  }

  // ============================================================
  // URL Sync
  // ============================================================

  /** Schedule URL sync (debounced). Internal — fires off enabled/viewState mutations. */
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

    // Preserve the pre-F-C URL ordering (builtInLayerIds order, then user
    // layers in registry order) so URL strings stay stable across the
    // refactor.
    const set = this.enabledLayers.value;
    const enabledLayers: string[] = builtInLayerIds.filter(id => set.has(id));
    if (this.layerService) {
      for (const layer of this.layerService.getAll()) {
        if (!layer.isBuiltIn && layer.id !== '_preview' && set.has(layer.id)) {
          enabledLayers.push(layer.id);
        }
      }
    }

    // Build URL manually to keep commas unencoded
    let search = this.event ? `?event=${this.event}&` : '?';
    search += `dt=${dt}&ll=${ll}&alt=${alt}`;
    if (enabledLayers.length > 0) {
      search += `&layers=${enabledLayers.join(',')}`;
    }

    // Preserve perftest param
    if (new URLSearchParams(location.search).has('perftest')) {
      search += '&perftest';
    }

    window.history.replaceState(null, '', search);
  }

  private formatDateForUrl(date: Date): string {
    return date.toISOString().slice(0, 16).replace(':', 'h') + 'z';
  }
}
