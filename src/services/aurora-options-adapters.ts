/**
 * Per-scope option adapters — Phase B plumbing for the catalog inversion.
 *
 * The host's option dialog (Phase C+) renders one generic control per
 * descriptor; that control reads/writes through the adapter matched to
 * `descriptor.scope`. Adapters are domain-blind — they know how to:
 *   - `read`     a single descriptor's current value
 *   - `write`    a new value (optimistically updates source-of-truth)
 *   - `subscribe` to value changes for a single descriptor
 *
 * Three sources of truth, three adapters:
 *   - `host`   → wraps `optionsService` (zero-db backed)
 *   - `engine` → wraps `auroraService.optionsMirror.engine` + dispatches
 *                 `setEngineOptions` to the worker (aurora-db backed)
 *   - `layer`  → wraps `auroraService.optionsMirror.layers[layerId]` +
 *                 dispatches `setLayerOptions`/`setLayerOpacity`
 *
 * No UI consumer yet — Phase C migrates the graticule dialog section as
 * the pilot. This file is plumbing.
 */

import { effect } from '@preact/signals-core';
import type { OptionDescriptor } from '../aurora/types/options-descriptor';
import type { AuroraService } from './aurora-service';
import type { OptionsService } from './options-service';

export interface OptionsAdapter {
  read(d: OptionDescriptor): unknown;
  write(d: OptionDescriptor, value: unknown): void;
  /** Subscribe to value changes for `d`; returns a disposer. */
  subscribe(d: OptionDescriptor, fn: (value: unknown) => void): () => void;
}

// ─── path helpers ──────────────────────────────────────────────────────────

function getByPath(obj: unknown, path: string): unknown {
  const segments = path.split('.');
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1]!] = value;
}

// ─── adapters ──────────────────────────────────────────────────────────────

export function createHostAdapter(optionsService: OptionsService): OptionsAdapter {
  return {
    read(d) {
      return getByPath(optionsService.options.value, d.key);
    },
    write(d, value) {
      optionsService.update(draft => {
        setByPath(draft as unknown as Record<string, unknown>, d.key, value);
      });
    },
    subscribe(d, fn) {
      let last = getByPath(optionsService.options.value, d.key);
      return effect(() => {
        const cur = getByPath(optionsService.options.value, d.key);
        if (cur !== last) { last = cur; fn(cur); }
      });
    },
  };
}

export function createEngineAdapter(auroraService: AuroraService): OptionsAdapter {
  const mirror = auroraService.optionsMirror;
  return {
    read(d) {
      return mirror.value?.engine[d.key as keyof typeof mirror.value.engine];
    },
    write(d, value) {
      // Optimistic: patch mirror locally so UI snaps. Worker echoes back the
      // same value via `optionsChanged` (no-op).
      const cur = mirror.value;
      if (cur) {
        mirror.value = {
          ...cur,
          engine: { ...cur.engine, [d.key]: value },
        };
      }
      auroraService.setEngineOptions({ [d.key]: value });
    },
    subscribe(d, fn) {
      let last: unknown = mirror.value?.engine[d.key as keyof typeof mirror.value.engine];
      return effect(() => {
        const cur = mirror.value?.engine[d.key as keyof typeof mirror.value.engine];
        if (cur !== last) { last = cur; fn(cur); }
      });
    },
  };
}

export function createLayerAdapter(auroraService: AuroraService): OptionsAdapter {
  const mirror = auroraService.optionsMirror;
  const layerId = (d: OptionDescriptor): string => {
    if (!d.layerId) {
      throw new Error(`layerAdapter: descriptor '${d.key}' has no layerId`);
    }
    return d.layerId;
  };

  return {
    read(d) {
      const id = layerId(d);
      const entry = mirror.value?.layers[id];
      if (d.key === 'opacity') return entry?.opacity;
      const opts = entry?.opts as Record<string, unknown> | undefined;
      return opts?.[d.key];
    },
    write(d, value) {
      const id = layerId(d);
      const cur = mirror.value;
      if (cur) {
        const entry = cur.layers[id] ?? { opacity: 0, opts: {} };
        const nextEntry = d.key === 'opacity'
          ? { ...entry, opacity: value as number }
          : { ...entry, opts: { ...(entry.opts as Record<string, unknown>), [d.key]: value } };
        mirror.value = {
          ...cur,
          layers: { ...cur.layers, [id]: nextEntry },
        };
      }
      if (d.key === 'opacity') {
        auroraService.setLayerOpacity(id, value as number);
      } else {
        auroraService.setLayerOptions(id, { [d.key]: value });
      }
    },
    subscribe(d, fn) {
      const id = layerId(d);
      const readCur = (): unknown => {
        const entry = mirror.value?.layers[id];
        if (d.key === 'opacity') return entry?.opacity;
        return (entry?.opts as Record<string, unknown> | undefined)?.[d.key];
      };
      let last = readCur();
      return effect(() => {
        const cur = readCur();
        if (cur !== last) { last = cur; fn(cur); }
      });
    },
  };
}

/** Bundle helper — host code that needs all three adapters can call once. */
export function createOptionsAdapters(
  optionsService: OptionsService,
  auroraService: AuroraService,
): Record<OptionDescriptor['scope'], OptionsAdapter> {
  return {
    host: createHostAdapter(optionsService),
    engine: createEngineAdapter(auroraService),
    layer: createLayerAdapter(auroraService),
  };
}
