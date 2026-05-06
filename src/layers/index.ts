/**
 * Built-in Layer Declarations
 *
 * Composed built-ins (earth/sun/temp/rain/clouds) still live here and use the
 * `defineLayer` builder — Phase 6.3 (item 8) absorbs their GPU config into
 * aurora's catalog.
 *
 * Thinned built-ins (graticule/cities/wind/pressure) come from aurora's
 * catalog at `src/aurora/built_ins/catalog.ts`; the adapter below widens
 * catalog entries into the host's richer `LayerDeclaration` shape.
 *
 * Registered in LayerService.registerBuiltInLayers() at bootstrap.
 */

import { layer as earthLayer } from './earth';
import { layer as sunLayer } from './sun';
import { layer as tempLayer } from './temp';
import { layer as rainLayer } from './rain';
import { layer as cloudsLayer } from './clouds';
import { LAYER_CATALOG } from '../aurora/built_ins/catalog';
import type { LayerCatalogEntry } from '../aurora/types/layer-catalog';
import type { LayerDeclaration } from '../services/layer/layer-service';
import type { TLayer } from '../config/types';
import type { PaletteId } from '../services/palette-service';

// Re-export composed-layer declarations for consumers
export { earthLayer, sunLayer, tempLayer, rainLayer, cloudsLayer };

/**
 * Migration shim: widen aurora's `LayerCatalogEntry` (string-typed unions)
 * into host's `LayerDeclaration` (literal-typed unions). Casts are runtime
 * no-ops; types align by construction at the catalog source.
 */
function adaptCatalogEntry(entry: LayerCatalogEntry): LayerDeclaration {
  const decl: Partial<LayerDeclaration> = {
    id: entry.id as TLayer,                              // QC-OK: catalog id is built-in TLayer by construction
    label: entry.uiHints.defaultLabel,
    buttonLabel: entry.uiHints.defaultButtonLabel ?? entry.uiHints.defaultLabel,
    category: entry.uiHints.defaultCategory,
    isBuiltIn: true,
  };
  if (entry.type) decl.type = entry.type;
  if (entry.params) decl.params = entry.params as NonNullable<LayerDeclaration['params']>;       // QC-OK: TModelParam shape match
  if (entry.advection) decl.advection = entry.advection as NonNullable<LayerDeclaration['advection']>; // QC-OK: AdvectionConfig shape match
  if (entry.palettes) decl.palettes = entry.palettes as PaletteId[];               // QC-OK: PaletteId is string union
  if (entry.blendFn) decl.blendFn = entry.blendFn;
  if (entry.postFn) decl.postFn = entry.postFn;
  if (entry.config) decl.config = entry.config;
  if (entry.pass) decl.pass = entry.pass;
  if (entry.order !== undefined) decl.order = entry.order;
  if (entry.topology) decl.topology = entry.topology;
  return decl as LayerDeclaration;                                                   // QC-OK: matches defineLayer() cast
}

/**
 * All built-in layer declarations.
 *
 * Order is load-bearing: LayerService.registerBuiltIn assigns `layer.index`
 * by registration order, and shader-composer emits `LAYER_<id>` constants
 * pinned to those indices. Matches pre-Phase-6.2 order so persisted state
 * (URL ?layers, aurora-db opacities) survives the catalog migration.
 */
const catalogById = new Map(LAYER_CATALOG.map(e => [e.id, e]));
const fromCatalog = (id: string): LayerDeclaration => adaptCatalogEntry(catalogById.get(id)!);

export const builtInLayers: LayerDeclaration[] = [
  earthLayer,
  sunLayer,
  fromCatalog('graticule'),
  fromCatalog('cities'),
  tempLayer,
  rainLayer,
  cloudsLayer,
  fromCatalog('pressure'),
  fromCatalog('wind'),
];
