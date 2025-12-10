/**
 * Decode temperature from .om file using chunked byte reads
 *
 * Simulates streaming: feed compressed data in 10 pieces
 */

import { readFileSync, writeFileSync } from 'fs';
import { OmFileReader } from '@openmeteo/file-reader';

const NUM_SLICES = 10;

// Backend that only serves bytes when they've been "streamed"
class StreamingBackend {
  constructor(buffer) {
    this.buffer = buffer;
    this.streamedUpTo = 0; // Bytes available so far
    this.pendingRequests = [];
    this.requestCount = 0;
  }

  // Simulate streaming: make more bytes available
  streamBytes(upTo) {
    this.streamedUpTo = upTo;
    // Resolve any pending requests that can now be fulfilled
    this.pendingRequests = this.pendingRequests.filter(({ offset, size, resolve }) => {
      if (offset + size <= this.streamedUpTo) {
        resolve(new Uint8Array(this.buffer.slice(offset, offset + size)));
        return false;
      }
      return true;
    });
  }

  async getBytes(offset, size) {
    this.requestCount++;

    // If bytes are available, return immediately
    if (offset + size <= this.streamedUpTo) {
      return new Uint8Array(this.buffer.slice(offset, offset + size));
    }

    // Otherwise wait for streaming
    return new Promise(resolve => {
      this.pendingRequests.push({ offset, size, resolve });
    });
  }

  async count() {
    return this.buffer.length;
  }
}

async function main() {
  const omPath = './data/sample.om';
  const outPath = './data/sample-03-streaming.temp.bin';

  console.log('=== Simulated Streaming Decode ===\n');

  const fileBuffer = readFileSync(omPath);
  const fileSize = fileBuffer.length;
  console.log(`File size: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);

  // First pass: find where temperature data lives
  console.log('\nPhase 1: Read metadata (end of file)...');

  // Make entire file available for init (we need metadata from end)
  const backend = new StreamingBackend(fileBuffer);
  backend.streamBytes(fileSize); // Metadata needs end of file

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
  const totalPoints = dims[1];
  console.log(`  Dims: [${dims.join(', ')}], Total: ${totalPoints.toLocaleString()} points`);
  console.log(`  Metadata requests: ${backend.requestCount}`);

  // Phase 2: Read in slices, simulating streaming
  console.log(`\nPhase 2: Decode in ${NUM_SLICES} slices...`);

  const sliceSize = Math.ceil(totalPoints / NUM_SLICES);
  const fullData = new Float32Array(totalPoints);

  backend.requestCount = 0;
  const t0 = performance.now();

  for (let i = 0; i < NUM_SLICES; i++) {
    const start = i * sliceSize;
    const end = Math.min(start + sliceSize, totalPoints);
    const sliceT0 = performance.now();

    const chunkData = await tempVar.read({
      type: 20, // FloatArray
      ranges: [
        { start: 0, end: dims[0] },
        { start: start, end: end }
      ]
    });

    fullData.set(chunkData, start);
    const ms = (performance.now() - sliceT0).toFixed(0);
    console.log(`  Slice ${i + 1}/${NUM_SLICES}: [${start.toLocaleString()} - ${end.toLocaleString()}] in ${ms}ms`);
  }

  console.log(`\n  Total decode: ${(performance.now() - t0).toFixed(0)}ms`);
  console.log(`  Data requests: ${backend.requestCount}`);

  // Stats
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < fullData.length; i++) {
    if (fullData[i] < min) min = fullData[i];
    if (fullData[i] > max) max = fullData[i];
  }
  console.log(`  Range: ${min.toFixed(1)}°C to ${max.toFixed(1)}°C`);

  // Save
  writeFileSync(outPath, Buffer.from(fullData.buffer));
  console.log(`\nSaved: ${outPath}`);
}

main().catch(console.error);
