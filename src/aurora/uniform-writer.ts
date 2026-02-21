/**
 * Uniform Writer - Declarative GPU uniform pipeline
 *
 * Config entries declare their own GPU binding (type + pos),
 * and a generic writer handles them. No relay fields, no per-field boilerplate.
 */

import type { ZeroOptions } from '../schemas/options.schema';
import { extractOptionsMeta } from '../schemas/options.schema';

// ============================================================
// ConfigEntry — layer config values that may bind to GPU uniforms
// ============================================================

export interface ConfigEntry {
  value: number | number[];
  type?: 'f32' | 'u32' | 'vec2f' | 'vec3f' | 'vec4f';
  pos?: number;   // byte offset in uniform buffer (from U.xxx)
}

/** Type guard: is this value a ConfigEntry with GPU binding? */
function isGpuEntry(val: unknown): val is ConfigEntry & { type: string; pos: number } {
  return !!val && typeof val === 'object' && 'pos' in val && 'type' in val
    && (val as ConfigEntry).pos !== undefined && (val as ConfigEntry).type !== undefined;
}

// ============================================================
// Writers
// ============================================================

/** Write all GPU-bound ConfigEntry values from a layer config to the uniform buffer */
export function writeConfigUniforms(view: DataView, config: Record<string, unknown>): void {
  for (const val of Object.values(config)) {
    if (!isGpuEntry(val)) continue;
    writeEntry(view, val.type, val.pos, val.value);
  }
}

/** Write a single typed value to the uniform buffer */
function writeEntry(view: DataView, type: string, pos: number, value: number | number[]): void {
  if (type === 'f32') { view.setFloat32(pos, value as number, true); return; }
  if (type === 'u32') { view.setUint32(pos, value as number, true); return; }
  // vec2f, vec3f, vec4f
  const arr = value as number[];
  for (let i = 0; i < arr.length; i++) view.setFloat32(pos + i * 4, arr[i]!, true);
}

/** Write option values that have `uniform` metadata to the uniform buffer */
export function writeOptionUniforms(view: DataView, opts: ZeroOptions): void {
  for (const flat of extractOptionsMeta()) {
    const meta = flat.meta as { uniform?: { type: string; pos: number } };
    if (!meta.uniform) continue;
    const value = getNestedValue(opts, flat.path);
    if (typeof value === 'number') {
      writeEntry(view, meta.uniform.type, meta.uniform.pos, value);
    }
  }
}

/** Resolve a dot-separated path on an object (e.g. "graticule.fontSize") */
function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  let current: unknown = obj;
  for (const key of dotPath.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
