/**
 * Inspect .om file structure
 * Find where temperature_2m data chunks are located
 */

import { readFileSync } from 'fs';
import { OmFileReader } from '@openmeteo/file-reader';

class OmFileBackend {
  constructor(buffer) {
    this.buffer = buffer;
    this.requests = [];
  }

  async getBytes(offset, size) {
    this.requests.push({ offset, size });
    return new Uint8Array(this.buffer.slice(offset, offset + size));
  }

  async count() {
    return this.buffer.length;
  }
}

async function main() {
  const omPath = './data/sample.om';
  console.log('=== Inspect .om File ===\n');

  const fileBuffer = readFileSync(omPath);
  console.log(`File size: ${(fileBuffer.length / 1024 / 1024).toFixed(1)} MB`);

  const backend = new OmFileBackend(fileBuffer);
  const reader = await OmFileReader.create(backend);

  console.log(`\nInit requests: ${backend.requests.length}`);
  for (const r of backend.requests) {
    console.log(`  offset: ${r.offset.toLocaleString()}, size: ${r.size.toLocaleString()}`);
  }

  // Find temperature
  let tempVar = null;
  for (let i = 0; i < reader.numberOfChildren(); i++) {
    const child = await reader.getChild(i);
    if (child.getName() === 'temperature_2m') {
      tempVar = child;
      break;
    }
  }

  console.log(`\nAfter finding temp var, requests: ${backend.requests.length}`);

  // Now read a small range and see what byte requests it makes
  backend.requests = [];

  const dims = tempVar.getDimensions();
  console.log(`\nDims: [${dims.join(', ')}]`);

  // Read first 10k points
  console.log('\nReading first 10,000 points...');
  await tempVar.read({
    type: 20, // FloatArray
    ranges: [
      { start: 0, end: dims[0] },
      { start: 0, end: 10000 }
    ]
  });

  console.log(`\nRequests made: ${backend.requests.length}`);

  // Sort by offset
  backend.requests.sort((a, b) => a.offset - b.offset);

  let totalBytes = 0;
  for (const r of backend.requests.slice(0, 20)) {
    console.log(`  offset: ${r.offset.toLocaleString().padStart(12)}, size: ${r.size.toLocaleString().padStart(8)}`);
    totalBytes += r.size;
  }
  if (backend.requests.length > 20) {
    console.log(`  ... and ${backend.requests.length - 20} more`);
  }
  console.log(`\nTotal bytes fetched: ${(totalBytes / 1024).toFixed(1)} KB`);
}

main().catch(console.error);
