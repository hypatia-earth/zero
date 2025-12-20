/**
 * Uniform Struct Layout Calculator
 *
 * Calculates correct byte offsets for WebGPU uniform buffers,
 * respecting WGSL alignment rules. Prevents silent misalignment bugs.
 *
 * Alignment rules (WGSL):
 *   f32, u32, i32: 4-byte aligned
 *   vec2f, vec2u:  8-byte aligned
 *   vec3f, vec4f:  16-byte aligned
 *   mat4x4f:       16-byte aligned (64 bytes total)
 */

type WGSLType = 'f32' | 'u32' | 'i32' | 'vec2f' | 'vec3f' | 'vec4f' | 'mat4x4f';

const ALIGN: Record<WGSLType, number> = {
  f32: 4,
  u32: 4,
  i32: 4,
  vec2f: 8,
  vec3f: 16,
  vec4f: 16,
  mat4x4f: 16,
};

const SIZE: Record<WGSLType, number> = {
  f32: 4,
  u32: 4,
  i32: 4,
  vec2f: 8,
  vec3f: 12,
  vec4f: 16,
  mat4x4f: 64,
};

export interface StructField {
  name: string;
  type: WGSLType;
  offset: number;
  size: number;
}

export interface StructLayout {
  fields: StructField[];
  size: number;  // Total struct size (padded to largest alignment)
  offsets: Record<string, number>;
}

/**
 * Calculate uniform struct layout with correct alignment
 *
 * @param fields Array of [name, type] tuples in declaration order
 * @returns Layout with offsets for each field
 *
 * @example
 * const layout = layoutStruct([
 *   ['viewMatrix', 'mat4x4f'],
 *   ['eyePosition', 'vec3f'],
 *   ['time', 'f32'],
 *   ['resolution', 'vec2f'],  // auto-pads to 8-byte boundary
 * ]);
 *
 * view.setFloat32(layout.offsets.time, uniforms.time, true);
 */
export function layoutStruct(fields: [string, WGSLType][]): StructLayout {
  let offset = 0;
  let maxAlign = 4;
  const result: StructField[] = [];
  const offsets: Record<string, number> = {};

  for (const [name, type] of fields) {
    const align = ALIGN[type];
    const size = SIZE[type];

    // Track max alignment for final struct padding
    maxAlign = Math.max(maxAlign, align);

    // Align offset up to required boundary
    const padding = (align - (offset % align)) % align;
    offset += padding;

    result.push({ name, type, offset, size });
    offsets[name] = offset;

    offset += size;
  }

  // Struct size must be multiple of largest alignment
  const structPadding = (maxAlign - (offset % maxAlign)) % maxAlign;
  const totalSize = offset + structPadding;

  return { fields: result, size: totalSize, offsets };
}

/**
 * Generate WGSL struct definition with explicit padding
 * Useful for debugging or code generation
 */
export function generateWGSL(name: string, layout: StructLayout): string {
  const lines = [`struct ${name} {`];
  let lastEnd = 0;
  let padIndex = 0;

  for (const field of layout.fields) {
    // Add padding field if there's a gap
    if (field.offset > lastEnd) {
      const padSize = field.offset - lastEnd;
      const padCount = padSize / 4;
      if (padCount === 1) {
        lines.push(`  _pad${padIndex++}: f32,`);
      } else {
        lines.push(`  _pad${padIndex++}: array<f32, ${padCount}>,`);
      }
    }
    lines.push(`  ${field.name}: ${field.type},`);
    lastEnd = field.offset + field.size;
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Validate that a DataView has correct size for the struct
 */
export function validateBufferSize(layout: StructLayout, buffer: ArrayBuffer): void {
  if (buffer.byteLength < layout.size) {
    throw new Error(
      `Uniform buffer too small: ${buffer.byteLength} bytes, need ${layout.size} bytes`
    );
  }
}

/**
 * Debug helper: print layout with offsets
 */
export function printLayout(layout: StructLayout): void {
  console.log('Struct Layout (size: ' + layout.size + ' bytes)');
  console.log('─'.repeat(50));
  for (const field of layout.fields) {
    const end = field.offset + field.size;
    console.log(
      `  ${field.offset.toString().padStart(4)} - ${end.toString().padStart(4)}  ${field.type.padEnd(8)} ${field.name}`
    );
  }
}
