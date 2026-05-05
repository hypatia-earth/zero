/**
 * Option descriptors — runtime metadata aurora publishes for each option.
 *
 * Authored under `src/aurora/options/descriptors.ts`; stamped with `scope`
 * (and `layerId` for layer descriptors) by `getEngineOptionsCatalog()` and
 * the layer-catalog walker. Host renders generic per-`kind` controls and
 * routes reads/writes through per-scope adapters.
 */

export type OptionScope = 'host' | 'engine' | 'layer';

export type OptionKind =
  | 'integer'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'color'
  | 'palette'
  | 'rgb'
  | 'pressureColors';

export type OptionImpact = 'live' | 'recreate' | 'reload';

export interface OptionEnumValue {
  value: unknown;
  labelKey?: string;
}

export interface OptionDescriptor {
  scope: OptionScope;
  /** Set when `scope === 'layer'`. */
  layerId?: string;
  /** Stable key (e.g. 'spacing', 'showLogo'). Adapters look up by `scope` + `key` (+ `layerId`). */
  key: string;
  kind: OptionKind;
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  enum?: OptionEnumValue[];
  impact?: OptionImpact;
  /** Optional dialog-section hint; final layout is host-side. */
  group?: string;
}

/** Author-shape: omit `scope`/`layerId` since the catalog walker stamps them. */
export type OptionDescriptorAuthor = Omit<OptionDescriptor, 'scope' | 'layerId'>;
