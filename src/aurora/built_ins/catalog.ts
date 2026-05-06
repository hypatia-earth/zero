/**
 * Aurora's built-in layer catalog — pure data, source of truth for
 * built-in layer metadata. Both main thread and worker import from here;
 * the host adapts entries into its `LayerDeclaration` shape via a shim
 * during migration (see `src/layers/index.ts`).
 *
 * Phase 6 of aurora-autarky Sub-B (catalog inversion). Today: 4 thinned
 * built-ins (graticule/cities/wind/pressure). Phase 6.3 absorbs the
 * 5 composed built-ins (earth/sun/temp/rain/clouds) with their GPU config.
 */

import type { LayerCatalogEntry } from '../types/layer-catalog';

export const LAYER_CATALOG: readonly LayerCatalogEntry[] = [
  {
    id: 'graticule',
    type: 'decoration',
    uiHints: { defaultLabel: 'Grid', defaultCategory: 'reference' },
  },
  {
    id: 'cities',
    type: 'decoration',
    uiHints: { defaultLabel: 'Cities', defaultCategory: 'reference' },
  },
  {
    id: 'wind',
    uiHints: { defaultLabel: 'Wind', defaultCategory: 'weather' },
    params: [
      { model: 'ecmwf_ifs', param: 'wind_u_component_10m' },
      { model: 'ecmwf_ifs', param: 'wind_v_component_10m' },
    ],
    palettes: ['wind-speed'],
  },
  {
    id: 'pressure',
    uiHints: { defaultLabel: 'Pressure', defaultCategory: 'weather' },
    params: [{ model: 'ecmwf_ifs', param: 'pressure_msl' }],
    palettes: ['pressure-gradient'],
  },
];

export function getLayerCatalog(): readonly LayerCatalogEntry[] {
  return LAYER_CATALOG;
}
