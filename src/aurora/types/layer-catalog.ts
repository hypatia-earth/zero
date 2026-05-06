/**
 * LayerCatalogEntry — aurora's published description of a built-in layer.
 *
 * Pure data, importable from main thread + worker. Replaces host-side
 * `defineLayer()` calls for built-in layers. Host adapts entries into
 * its richer `LayerDeclaration` shape via a thin shim during migration.
 *
 * Aurora-side types only (no host imports) so the catalog stays autarky-pure
 * and Sub-B Phase 9's outward-import cleanup doesn't touch this file.
 */

export type LayerCatalogType = 'decoration' | 'texture' | 'geometry' | 'solid';
export type LayerCatalogPass = 'surface' | 'geometry' | 'post';
export type LayerCatalogCategory = 'celestial' | 'weather' | 'reference' | 'custom';

export interface LayerCatalogParam {
  model: string;
  param: string;
}

export interface LayerCatalogAdvection {
  uParam: LayerCatalogParam;
  vParam: LayerCatalogParam;
  targets: LayerCatalogParam[];
}

export interface LayerCatalogUiHints {
  defaultLabel: string;
  defaultButtonLabel?: string;
  defaultCategory: LayerCatalogCategory;
}

export interface LayerCatalogEntry {
  id: string;
  type?: LayerCatalogType;
  uiHints: LayerCatalogUiHints;

  // Optional runtime fields — populated by composed/parameterized layers
  params?: LayerCatalogParam[];
  advection?: LayerCatalogAdvection;
  palettes?: string[];
  blendFn?: string;
  postFn?: string;
  config?: Record<string, unknown>;
  pass?: LayerCatalogPass;
  order?: number;
  topology?: 'triangle-list' | 'line-list';
}
