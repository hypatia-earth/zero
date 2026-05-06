/**
 * Per-scope option adapters — F-A path-based API.
 *
 * The host's options dialog renders one generic control per FlatOption,
 * routing reads/writes through one of three adapters keyed by path prefix:
 *
 *   - host paths   (no `engine.` / `layers.` prefix) → `hostAdapter`
 *     (zero-db backed via `optionsService`)
 *   - `engine.<key>` paths                            → `engineAdapter`
 *     (aurora-db backed; reads from `auroraService.optionsMirror.engine`,
 *     writes via `setEngineOptions` worker dispatch)
 *   - `layers.<id>.opacity`     paths                  → `layerAdapter`
 *     (writes via `setLayerOpacity`)
 *   - `layers.<id>.opts.<key>`  paths                  → `layerAdapter`
 *     (writes via `setLayerOptions`)
 *
 * Adapters are domain-blind — they parse the path string and dispatch to
 * the right worker message kind. The dialog never names a layer id or
 * engine key directly.
 */

import { auroraDefaults } from '../aurora/options/schema';
import { defaultOptions } from '../schemas/options.schema';
import type { AuroraService } from './aurora-service';
import type { OptionsService } from './options-service';

export interface OptionsAdapter {
  read(path: string): unknown;
  write(path: string, value: unknown): void;
  getDefault(path: string): unknown;
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

/** Decompose `layers.<id>.opacity` or `layers.<id>.opts.<key>`. */
function parseLayerPath(path: string): { id: string; opacityOnly: boolean; key?: string } {
  const segments = path.split('.');
  // segments: ['layers', id, 'opacity'] or ['layers', id, 'opts', key]
  const id = segments[1]!;
  if (segments[2] === 'opacity' && segments.length === 3) {
    return { id, opacityOnly: true };
  }
  if (segments[2] === 'opts' && segments.length === 4) {
    return { id, opacityOnly: false, key: segments[3]! };
  }
  throw new Error(`layerAdapter: unrecognized layer path '${path}'`);
}

/** Strip the leading namespace (`engine.` or `layers.`). */
function tail(path: string, prefix: string): string {
  return path.slice(prefix.length);
}

// ─── adapters ──────────────────────────────────────────────────────────────

export function createHostAdapter(optionsService: OptionsService): OptionsAdapter {
  return {
    read(path) {
      return getByPath(optionsService.options.value, path);
    },
    write(path, value) {
      optionsService.update(draft => {
        setByPath(draft as unknown as Record<string, unknown>, path, value);
      });
    },
    getDefault(path) {
      return getByPath(defaultOptions, path);
    },
  };
}

export function createEngineAdapter(auroraService: AuroraService): OptionsAdapter {
  const mirror = auroraService.optionsMirror;
  return {
    read(path) {
      const key = tail(path, 'engine.');
      return mirror.value?.engine[key as keyof typeof mirror.value.engine];
    },
    write(path, value) {
      const key = tail(path, 'engine.');
      // Optimistic mirror patch — worker echoes back via 'optionsChanged'.
      const cur = mirror.value;
      if (cur) {
        mirror.value = {
          ...cur,
          engine: { ...cur.engine, [key]: value },
        };
      }
      auroraService.setEngineOptions({ [key]: value });
    },
    getDefault(path) {
      const key = tail(path, 'engine.');
      return (auroraDefaults.engine as Record<string, unknown>)[key];
    },
  };
}

export function createLayerAdapter(auroraService: AuroraService): OptionsAdapter {
  const mirror = auroraService.optionsMirror;
  return {
    read(path) {
      const { id, opacityOnly, key } = parseLayerPath(path);
      const entry = mirror.value?.layers[id];
      if (opacityOnly) return entry?.opacity;
      const opts = entry?.opts as Record<string, unknown> | undefined;
      return opts?.[key!];
    },
    write(path, value) {
      const { id, opacityOnly, key } = parseLayerPath(path);
      const cur = mirror.value;
      if (cur) {
        const entry = cur.layers[id] ?? { opacity: 0, opts: {} };
        const nextEntry = opacityOnly
          ? { ...entry, opacity: value as number }
          : { ...entry, opts: { ...(entry.opts as Record<string, unknown>), [key!]: value } };
        mirror.value = {
          ...cur,
          layers: { ...cur.layers, [id]: nextEntry },
        };
      }
      if (opacityOnly) {
        auroraService.setLayerOpacity(id, value as number);
      } else {
        auroraService.setLayerOptions(id, { [key!]: value });
      }
    },
    getDefault(path) {
      const { id, opacityOnly, key } = parseLayerPath(path);
      const layerDefaults = auroraDefaults.layers[id as keyof typeof auroraDefaults.layers];
      if (!layerDefaults) return undefined;
      if (opacityOnly) return layerDefaults.opacity;
      return (layerDefaults.opts as Record<string, unknown>)[key!];
    },
  };
}

/** Path → adapter routing. The single classifier for adapter dispatch. */
export function adapterFor(
  path: string,
  hostAdapter: OptionsAdapter,
  engineAdapter: OptionsAdapter,
  layerAdapter: OptionsAdapter,
): OptionsAdapter {
  if (path.startsWith('engine.')) return engineAdapter;
  if (path.startsWith('layers.')) return layerAdapter;
  return hostAdapter;
}
