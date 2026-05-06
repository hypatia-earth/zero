/**
 * Built-in Layer Declarations
 *
 * All 9 built-ins (earth/sun/graticule/cities/temp/rain/clouds/pressure/wind)
 * come from aurora's catalog at `src/aurora/built_ins/catalog.ts`. The shim
 * below widens catalog entries into the host's richer `LayerDeclaration`
 * shape; registration order is preserved by the catalog itself.
 *
 * Registered in LayerService.registerBuiltInLayers() at bootstrap.
 *
 * Phase 6.4 cleanup will fold the shim + this re-export into LayerService
 * directly and shrink LayerService to user-layer registration only.
 */

import { LAYER_CATALOG } from '../aurora/built_ins/catalog';
import type { LayerCatalogEntry } from '../aurora/types/layer-catalog';
import type { LayerDeclaration } from '../services/layer/layer-service';
import type { TLayer } from '../config/types';
import type { PaletteId } from '../services/palette-service';

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

/** All built-in layer declarations, derived from aurora's catalog. */
export const builtInLayers: LayerDeclaration[] = LAYER_CATALOG.map(adaptCatalogEntry);
