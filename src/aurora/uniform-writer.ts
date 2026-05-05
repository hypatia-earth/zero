/**
 * Uniform Writer - Declarative GPU uniform pipeline
 *
 * Config entries declare their own GPU binding (type + pos),
 * and a generic writer handles them. No relay fields, no per-field boilerplate.
 */


// ============================================================
// ConfigEntry — layer config values that may bind to GPU uniforms
// ============================================================

export interface ConfigEntry {
  value: number | number[];
  type?: 'f32' | 'u32' | 'vec2f' | 'vec3f' | 'vec4f';
  pos?: number;   // byte offset in uniform buffer (from U.xxx)
}

/** Read a numeric ConfigEntry value from a layer config bag */
export function configValue(config: Record<string, unknown>, key: string): number {
  return (config[key] as ConfigEntry).value as number;
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

