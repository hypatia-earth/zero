/**
 * Extract compressed temperature data from .om file
 * Intercept all byte requests and save them
 */

import { readFileSync, writeFileSync } from 'fs';
import { OmFileReader } from '@openmeteo/file-reader';

class OmFileBackend {
  constructor(buffer) {
    this.buffer = buffer;
    this.requests = [];
  }

  async getBytes(offset, size) {
    const data = new Uint8Array(this.buffer.slice(offset, offset + size));
    this.requests.push({ offset, size, data });
    return data;
  }

  async count() {
    return this.buffer.length;
  }
}

async function main() {
  const omPath = './data/sample.om';
  console.log('=== Extract Compressed Temp Data ===\n');

  const fileBuffer = readFileSync(omPath);
  console.log(`File size: ${(fileBuffer.length / 1024 / 1024).toFixed(1)} MB`);

  const backend = new OmFileBackend(fileBuffer);
  const reader = await OmFileReader.create(backend);

  // Find temperature
  let tempVar = null;
  for (let i = 0; i < reader.numberOfChildren(); i++) {
    const child = await reader.getChild(i);
    if (child.getName() === 'temperature_2m') {
      tempVar = child;
      break;
    }
  }

  const dims = tempVar.getDimensions();
  console.log(`Dims: [${dims.join(', ')}]`);

  // Clear requests, now capture only data reads
  backend.requests = [];

  // Read ALL points
  console.log('\nReading all points (capturing compressed bytes)...');
  const t0 = performance.now();

  await tempVar.read({
    type: 20, // FloatArray
    ranges: [
      { start: 0, end: dims[0] },
      { start: 0, end: dims[1] }
    ]
  });

  console.log(`  Done in ${(performance.now() - t0).toFixed(0)}ms`);
  console.log(`  Requests: ${backend.requests.length}`);

  // Sort by offset and merge into single buffer
  backend.requests.sort((a, b) => a.offset - b.offset);

  let totalBytes = 0;
  for (const r of backend.requests) {
    totalBytes += r.size;
  }
  console.log(`  Total compressed bytes: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

  // Create a combined buffer with all compressed data
  // Also save a manifest of offset/size pairs
  const manifest = backend.requests.map(r => ({ offset: r.offset, size: r.size }));

  const compressedBuffer = new Uint8Array(totalBytes);
  let pos = 0;
  for (const r of backend.requests) {
    compressedBuffer.set(r.data, pos);
    pos += r.size;
  }

  // Save compressed data
  const compressedPath = './data/sample.temp.compressed';
  writeFileSync(compressedPath, Buffer.from(compressedBuffer));
  console.log(`\nSaved: ${compressedPath}`);

  // Save manifest
  const manifestPath = './data/sample.temp.manifest.json';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Saved: ${manifestPath} (${manifest.length} chunks)`);

  // Show some chunks
  console.log('\nFirst 10 chunks:');
  for (const r of manifest.slice(0, 10)) {
    console.log(`  offset: ${r.offset.toLocaleString().padStart(12)}, size: ${r.size.toLocaleString().padStart(6)}`);
  }
}

main().catch(console.error);
