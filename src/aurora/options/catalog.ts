/**
 * Aurora option-catalog assembly — stamps `scope`/`layerId` onto authored
 * descriptors and exposes the catalog readers consumed by the host adapter
 * layer (Phase B+) and the defaults walker (Phase A).
 */

import type { OptionDescriptor, OptionDescriptorAuthor } from '../types/options-descriptor';
import type { AuroraOptions as AuroraOptionsBlob, EngineOpts, LayerEntry } from '../types/options';
import {
  ENGINE_OPTION_DESCRIPTORS,
  GRATICULE_OPTION_DESCRIPTORS,
  CITIES_OPTION_DESCRIPTORS,
  WIND_OPTION_DESCRIPTORS,
  PRESSURE_OPTION_DESCRIPTORS,
  RAIN_OPTION_DESCRIPTORS,
} from './descriptors';

/** Minimal layer-options catalog shape (Phase A). Phase 6 promotes this to
 *  a full `LayerCatalogEntry` once the catalog publishes category/uiHints. */
export interface LayerOptionsCatalogEntry {
  id: string;
  options: OptionDescriptor[];
}

const LAYER_AUTHORS: { id: string; descriptors: OptionDescriptorAuthor[] }[] = [
  { id: 'graticule', descriptors: GRATICULE_OPTION_DESCRIPTORS },
  { id: 'cities',    descriptors: CITIES_OPTION_DESCRIPTORS },
  { id: 'wind',      descriptors: WIND_OPTION_DESCRIPTORS },
  { id: 'pressure',  descriptors: PRESSURE_OPTION_DESCRIPTORS },
  { id: 'rain',      descriptors: RAIN_OPTION_DESCRIPTORS },
];

export function getEngineOptionsCatalog(): OptionDescriptor[] {
  return ENGINE_OPTION_DESCRIPTORS.map(d => ({ ...d, scope: 'engine' as const }));
}

export function getLayerOptionsCatalog(): LayerOptionsCatalogEntry[] {
  return LAYER_AUTHORS.map(({ id, descriptors }) => ({
    id,
    options: descriptors.map(d => ({ ...d, scope: 'layer' as const, layerId: id })),
  }));
}

/** Walks engine + layer catalogs to build the full default options blob.
 *  Replaces the hardcoded `AURORA_OPTIONS_DEFAULTS` literal. Layer
 *  `opacity` defaults to 0 here; Phase E adds opacity descriptors. */
export function defaultsFromCatalog(): AuroraOptionsBlob {
  const engine = {} as Record<string, unknown>;
  for (const d of getEngineOptionsCatalog()) engine[d.key] = d.default;

  const layers: Record<string, LayerEntry> = {};
  for (const entry of getLayerOptionsCatalog()) {
    const opts: Record<string, unknown> = {};
    for (const d of entry.options) opts[d.key] = d.default;
    layers[entry.id] = { opacity: 0, opts };
  }
  return { engine: engine as unknown as EngineOpts, layers };
}
