/**
 * TimestepService - Unified timestep state management
 *
 * Tracks timestep availability across three levels:
 * - ECMWF: global (same for all params)
 * - Cache: per param (from Service Worker)
 * - GPU: per param (set by SlotService when textures uploaded)
 */

import { signal } from '@preact/signals-core';
import type { TParam, TTimestep, TModel, Timestep, IDiscoveryService } from '../config/types';
import type { ConfigService } from './config-service';
import { DiscoveryService } from './discovery-service';

/** Timestep state per param */
export interface ParamState {
  cache: Set<TTimestep>;
  gpu: Set<TTimestep>;
}

/** TimestepService state exposed via signal */
export interface TimestepState {
  ecmwf: Set<TTimestep>;
  params: Map<TParam, ParamState>;
}

/** SW cache layer detail response */
interface LayerDetail {
  items: Array<{ url: string }>;
}

const PARAMS: TParam[] = ['temp', 'rain', 'wind', 'pressure'];

export class TimestepService implements IDiscoveryService {
  private discovery: DiscoveryService;

  /** Reactive state for UI */
  readonly state = signal<TimestepState>({
    ecmwf: new Set(),
    params: new Map(PARAMS.map(p => [p, { cache: new Set(), gpu: new Set() }])),
  });

  constructor(configService: ConfigService) {
    this.discovery = new DiscoveryService(configService);
  }

  /** Initialize: explore ECMWF and query SW cache */
  async initialize(): Promise<void> {
    // Explore ECMWF
    await this.discovery.explore();

    // Build ECMWF set from discovered timesteps
    const ecmwf = new Set<TTimestep>();
    for (const ts of this.discovery.timesteps()) {
      ecmwf.add(ts.timestep);
    }

    // Query SW cache for each param
    const params = new Map<TParam, ParamState>();
    for (const param of PARAMS) {
      const cache = await this.querySWCache(param);
      params.set(param, { cache, gpu: new Set() });
    }

    this.state.value = { ecmwf, params };
  }

  /** Query Service Worker for cached timesteps */
  private async querySWCache(param: TParam): Promise<Set<TTimestep>> {
    const cached = new Set<TTimestep>();

    try {
      if (!navigator.serviceWorker.controller) return cached;

      const detail = await this.sendSWMessage<LayerDetail>({
        type: 'GET_LAYER_STATS',
        layer: param,
      });

      // Parse timesteps from cached URLs
      // URL format: .../2025-12-14T0600.om
      for (const item of detail.items) {
        const match = /(\d{4}-\d{2}-\d{2}T\d{4})\.om/.exec(item.url);
        if (match) {
          cached.add(match[1] as TTimestep);
        }
      }
    } catch {
      // SW not available or error - return empty
    }

    return cached;
  }

  /** Send message to SW */
  private sendSWMessage<T>(message: object): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!navigator.serviceWorker.controller) {
        reject(new Error('No active Service Worker'));
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data as T);
      navigator.serviceWorker.controller.postMessage(message, [channel.port2]);
    });
  }

  /** Mark timestep as loaded in GPU (called by SlotService) */
  setGpuLoaded(param: TParam, timestep: TTimestep): void {
    const current = this.state.value;
    const paramState = current.params.get(param);
    if (!paramState) return;

    paramState.gpu.add(timestep);

    // Trigger signal update
    this.state.value = { ...current };
  }

  /** Mark timestep as unloaded from GPU (called by SlotService) */
  setGpuUnloaded(param: TParam, timestep: TTimestep): void {
    const current = this.state.value;
    const paramState = current.params.get(param);
    if (!paramState) return;

    paramState.gpu.delete(timestep);

    // Trigger signal update
    this.state.value = { ...current };
  }

  /** Check if timestep is available at ECMWF */
  isAvailable(timestep: TTimestep): boolean {
    return this.state.value.ecmwf.has(timestep);
  }

  /** Check if timestep is cached in SW */
  isCached(param: TParam, timestep: TTimestep): boolean {
    return this.state.value.params.get(param)?.cache.has(timestep) ?? false;
  }

  /** Check if timestep is loaded in GPU */
  isGpuLoaded(param: TParam, timestep: TTimestep): boolean {
    return this.state.value.params.get(param)?.gpu.has(timestep) ?? false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // IDiscoveryService delegation
  // ─────────────────────────────────────────────────────────────────────────────

  explore(): Promise<void> {
    return this.initialize();
  }

  toDate(ts: TTimestep): Date {
    return this.discovery.toDate(ts);
  }

  toTimestep(date: Date): TTimestep {
    return this.discovery.toTimestep(date);
  }

  toKey(ts: TTimestep): string {
    return this.discovery.toKey(ts);
  }

  next(ts: TTimestep, model?: TModel): TTimestep | null {
    return this.discovery.next(ts, model);
  }

  prev(ts: TTimestep, model?: TModel): TTimestep | null {
    return this.discovery.prev(ts, model);
  }

  adjacent(time: Date, model?: TModel): [TTimestep, TTimestep] {
    return this.discovery.adjacent(time, model);
  }

  url(ts: TTimestep, model?: TModel): string {
    return this.discovery.url(ts, model);
  }

  first(model?: TModel): TTimestep {
    return this.discovery.first(model);
  }

  last(model?: TModel): TTimestep {
    return this.discovery.last(model);
  }

  index(ts: TTimestep, model?: TModel): number {
    return this.discovery.index(ts, model);
  }

  contains(ts: TTimestep, model?: TModel): boolean {
    return this.discovery.contains(ts, model);
  }

  variables(model?: TModel): string[] {
    return this.discovery.variables(model);
  }

  timesteps(model?: TModel): Timestep[] {
    return this.discovery.timesteps(model);
  }
}
