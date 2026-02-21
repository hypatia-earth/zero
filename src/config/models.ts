/**
 * Model Registry — single source of truth for model/param types
 *
 * Types are derived from model definitions, not hand-written unions.
 * Import model/param types from here (or from types.ts which re-exports).
 */

import { ECMWF_IFS, type TEcmwfIfsParam } from './om-ecmwf-ifs';
import { NCEP_GFS025, type TNcepGfs025Param } from './om-ncep-gfs025';
import { PARAM_METADATA as EXTENDED_CATALOG } from './params-ecmwf_ifs.old';

export { ECMWF_IFS } from './om-ecmwf-ifs';
export { NCEP_GFS025 } from './om-ncep-gfs025';
export type { ParamMeta } from './om-ecmwf-ifs';

// ─────────────────────────────────────────────────────────────────────────────
// Derived types — all from model definitions, no hand-written unions
// ─────────────────────────────────────────────────────────────────────────────

/** All known model names */
export type TModel = typeof ECMWF_IFS.name | typeof NCEP_GFS025.name;

/** Per-model param name types (internal — use TModelParam outside) */
type TIfsParam = TEcmwfIfsParam;
type TGfsParam = TNcepGfs025Param;

/** All parameter names across all models (internal to model registry) */
type TParameter = TIfsParam | TGfsParam;

/** Parameter with its source model — discriminated union, derived from definitions */
export type TModelParam =
  | { model: typeof ECMWF_IFS.name; param: TIfsParam }
  | { model: typeof NCEP_GFS025.name; param: TGfsParam };

// ─────────────────────────────────────────────────────────────────────────────
// Runtime model registry
// ─────────────────────────────────────────────────────────────────────────────

/** All registered models */
export const MODELS = [ECMWF_IFS, NCEP_GFS025] as const;

/** GPU buffer size per model grid */
export const MODEL_BUFFER_MB: Record<TModel, number> = {
  [ECMWF_IFS.name]: ECMWF_IFS.bufferMB,
  [NCEP_GFS025.name]: NCEP_GFS025.bufferMB,
};

/** Get param metadata across all models (falls back to extended catalog) */
export function getParamMeta(param: TParameter) {
  for (const model of MODELS) {
    const meta = model.params[param as keyof typeof model.params];
    if (meta) return meta;
  }
  const extended = EXTENDED_CATALOG[param];
  if (extended) return extended;
  throw new Error(`Unknown param: ${param}`);
}

/** Get model definition by name */
export function getModel(name: TModel) {
  const model = MODELS.find(m => m.name === name);
  if (!model) throw new Error(`Unknown model: ${name}`);
  return model;
}

// ─────────────────────────────────────────────────────────────────────────────
// Param utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Get published params (available for custom layers) — IFS only, returns param names */
export function getPublishedParams(): TIfsParam[] {
  const result: TIfsParam[] = [];
  for (const [param, meta] of Object.entries(ECMWF_IFS.params)) {
    if ('published' in meta && meta.published) {
      result.push(param as TIfsParam);  // QC-OK: Object.entries loses key type
    }
  }
  return result;
}

/** Get all published params across all models as TModelParam[] (for create-layer dialog) */
export function getPublishedModelParams(): TModelParam[] {
  const result: TModelParam[] = [];
  for (const model of MODELS) {
    for (const [param, meta] of Object.entries(model.params)) {
      if ('published' in meta && meta.published) {
        result.push({ model: model.name, param } as TModelParam);  // QC-OK: param validated from model.params keys
      }
    }
  }
  return result;
}
