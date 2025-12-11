#!/usr/bin/env node
/**
 * Convert atmosphere LUT files from float32 to float16
 *
 * Input:  public/atmosphere/*.dat (rgba32float)
 * Output: public/atmosphere/*-16.dat (rgba16float)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const atmosphereDir = path.join(__dirname, '../public/atmosphere');

/**
 * Convert a float32 value to float16 (IEEE 754 half-precision)
 * @param {number} value - float32 value
 * @returns {number} - uint16 representing float16
 */
function float32ToFloat16(value) {
  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);

  floatView[0] = value;
  const f = int32View[0];

  const sign = (f >> 16) & 0x8000;
  const exponent = ((f >> 23) & 0xff) - 127 + 15;
  const mantissa = f & 0x7fffff;

  if (exponent <= 0) {
    // Subnormal or zero
    if (exponent < -10) {
      return sign; // Too small, return signed zero
    }
    const m = (mantissa | 0x800000) >> (1 - exponent);
    return sign | (m >> 13);
  } else if (exponent === 0xff - 127 + 15) {
    // Inf or NaN
    if (mantissa === 0) {
      return sign | 0x7c00; // Inf
    }
    return sign | 0x7c00 | (mantissa >> 13); // NaN
  } else if (exponent > 30) {
    // Overflow to Inf
    return sign | 0x7c00;
  }

  return sign | (exponent << 10) | (mantissa >> 13);
}

/**
 * Convert Float32Array to Uint16Array (float16)
 * @param {Float32Array} float32Data
 * @returns {Uint16Array}
 */
function convertToFloat16(float32Data) {
  const float16Data = new Uint16Array(float32Data.length);
  for (let i = 0; i < float32Data.length; i++) {
    float16Data[i] = float32ToFloat16(float32Data[i]);
  }
  return float16Data;
}

const files = ['transmittance', 'scattering', 'irradiance'];

for (const name of files) {
  const inputPath = path.join(atmosphereDir, `${name}.dat`);
  const outputPath = path.join(atmosphereDir, `${name}-16.dat`);

  console.log(`Converting ${name}.dat...`);

  const inputBuffer = fs.readFileSync(inputPath);
  const float32Data = new Float32Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.byteLength / 4);

  console.log(`  Input: ${float32Data.length} floats (${inputBuffer.byteLength} bytes)`);

  const float16Data = convertToFloat16(float32Data);
  const outputBuffer = Buffer.from(float16Data.buffer);

  fs.writeFileSync(outputPath, outputBuffer);

  console.log(`  Output: ${float16Data.length} half-floats (${outputBuffer.byteLength} bytes)`);
  console.log(`  Saved: ${outputPath}`);
}

console.log('\nDone! Float16 LUT files created.');
