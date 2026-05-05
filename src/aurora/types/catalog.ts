/**
 * Layer catalog — aurora publishes its built-in layers; host queries before init.
 *
 * Sub-B Phase 6 wires this up: aurora exposes `getLayerCatalog()`; the host
 * UI builds toggle lists from the catalog and may override labels/icons per
 * locale. App-side experimental layers (Aether sim layers) flow through
 * `AuroraLayerSpec` instead.
 */

import type { AssetSpec } from './asset';
import type { AuroraLayer } from './aurora-layer';
import type { OptionDescriptor } from './options-descriptor';

export type LayerCategory = 'composed' | 'composed-stateful' | 'autonomous';

export interface LayerUiHints {
  defaultLabel: string;
  defaultIcon?: string;
  defaultGroup: 'celestial' | 'weather' | 'reference' | string;
}

export interface LayerCatalogEntry {
  /** e.g., 'graticule', 'cities', 'wind', 'pressure', 'earth', 'sun'. */
  id: string;
  category: LayerCategory;
  uiHints: LayerUiHints;
  /** Typed by id at adapter sites (WindOpts | GraticuleOpts | …). */
  defaultOptions: unknown;
  /** Per-layer option descriptors (scope-stamped 'layer', layerId pre-set).
   *  Authored under `aurora/options/descriptors.ts`. */
  options: OptionDescriptor[];
  requiredAssets?: AssetSpec[];
  /** Data params this layer reads (e.g., 'wind_u_component_10m'). */
  requiresParams?: string[];
}

/** Spec for app-side experimental layers — aurora does not know them intrinsically. */
export interface AuroraLayerSpec {
  id: string;
  category: LayerCategory;
  /** Required for app-side specs; built-ins are handled internally. */
  pluginFactory: () => AuroraLayer;
  pluginOrder: number;
  /** Optional — host UI may need to render the toggle. */
  uiHints?: LayerUiHints;
  requiredAssets?: AssetSpec[];
}
