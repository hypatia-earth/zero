/**
 * PoC: Streaming decode from AWS with minimal requests
 *
 * Strategy:
 * 1. Fetch metadata from AWS (max 5 requests)
 * 2. Build chunk map for temperature variable
 * 3. Fetch data in N slices from AWS
 * 4. Decode with WASM
 *
 * Usage: node poc-streaming.js [numSlices]
 */

import { writeFileSync } from 'fs';
import { OmFileReader, OmDataType } from '@openmeteo/file-reader';

const NUM_SLICES = parseInt(process.argv[2] || '10', 10);
const AWS_URL = 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs/2025/12/10/0000Z/2025-12-10T0600.om';
const PARAM = 'temperature_2m';

let requestCount = 0;
let initRequestCount = 0;
let fileSize = null;

// AWS backend with logging
class AwsBackend {
  constructor(phase) {
    this.phase = phase;
    this.requests = [];
  }

  async getBytes(offset, size) {
    requestCount++;
    if (this.phase === 'init') initRequestCount++;

    const rangeHeader = `bytes=${offset}-${offset + size - 1}`;
    console.log(`  [${this.phase.toUpperCase()}] #${requestCount}: ${AWS_URL}`);
    console.log(`           Range: ${rangeHeader} (${size.toLocaleString()} bytes)`);

    this.requests.push({ offset, size });

    const response = await fetch(AWS_URL, {
      headers: { Range: rangeHeader }
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  async count() {
    if (fileSize !== null) return fileSize;

    requestCount++;
    initRequestCount++;
    console.log(`  [INIT] #${requestCount}: HEAD ${AWS_URL}`);

    const response = await fetch(AWS_URL, { method: 'HEAD' });
    fileSize = parseInt(response.headers.get('content-length'), 10);
    console.log(`           Size: ${fileSize.toLocaleString()} bytes`);
    return fileSize;
  }
}

async function main() {
  console.log('=== PoC: Streaming Decode from AWS ===\n');
  console.log(`Slices: ${NUM_SLICES}`);
  console.log(`URL: ${AWS_URL}\n`);

  const t0 = performance.now();

  // Phase 1: Init - fetch metadata from AWS
  console.log('Phase 1: Fetch metadata from AWS');
  const initBackend = new AwsBackend('init');
  const reader = await OmFileReader.create(initBackend);

  // Find temperature variable
  let tempVar = null;
  for (let i = 0; i < reader.numberOfChildren(); i++) {
    const child = await reader.getChild(i);
    if (child.getName() === PARAM) {
      tempVar = child;
      break;
    }
  }

  if (!tempVar) throw new Error(`Variable ${PARAM} not found`);

  const dims = tempVar.getDimensions();
  const totalPoints = dims[1];
  console.log(`\n  Found: ${PARAM}, dims=[${dims.join(',')}]`);
  console.log(`  Init requests: ${initRequestCount}`);

  // Phase 2: Build chunk map by doing a dummy read
  console.log('\nPhase 2: Build chunk map');
  initBackend.requests = [];

  // We need to know which bytes contain temp data
  // Do a read that captures the requests but serves from cache if possible
  const chunkMapBackend = new AwsBackend('map');
  chunkMapBackend.requests = initBackend.requests; // Share request log

  // Read to discover chunk locations (this will make requests)
  await tempVar.read({
    type: OmDataType.FloatArray,
    ranges: [
      { start: 0, end: dims[0] },
      { start: 0, end: totalPoints }
    ]
  });

  // Get data chunk locations from the requests made
  const dataChunks = initBackend.requests
    .filter(r => r.size > 1000)
    .sort((a, b) => a.offset - b.offset);

  console.log(`  Data chunks discovered: ${dataChunks.length}`);

  const minOffset = dataChunks[0].offset;
  const lastChunk = dataChunks[dataChunks.length - 1];
  const maxOffset = lastChunk.offset + lastChunk.size;
  const totalCompressed = maxOffset - minOffset;

  console.log(`  Data range: ${minOffset.toLocaleString()} - ${maxOffset.toLocaleString()} (${(totalCompressed / 1024 / 1024).toFixed(2)} MB)`);

  // Phase 3: Fetch data in slices
  console.log(`\nPhase 3: Fetch ${NUM_SLICES} data slices`);

  const sliceBytes = Math.ceil(totalCompressed / NUM_SLICES);
  const awsData = new Uint8Array(totalCompressed);
  const dataRequestStart = requestCount;

  for (let i = 0; i < NUM_SLICES; i++) {
    const sliceStart = i * sliceBytes;
    const sliceEnd = Math.min(sliceStart + sliceBytes, totalCompressed);
    const sliceSize = sliceEnd - sliceStart;
    const awsOffset = minOffset + sliceStart;

    requestCount++;
    const rangeHeader = `bytes=${awsOffset}-${awsOffset + sliceSize - 1}`;
    console.log(`  [DATA] #${requestCount}: ${AWS_URL}`);
    console.log(`          Range: ${rangeHeader} (${(sliceSize / 1024).toFixed(0)} KB)`);

    const response = await fetch(AWS_URL, {
      headers: { Range: rangeHeader }
    });

    const data = new Uint8Array(await response.arrayBuffer());
    awsData.set(data, sliceStart);
  }

  const dataRequests = requestCount - dataRequestStart;
  console.log(`\n  Data requests: ${dataRequests}`);

  // Phase 4: Decode with WASM
  console.log('\nPhase 4: Decode with WASM');

  // Backend that serves data from our fetched buffer
  class MemoryBackend {
    constructor(awsData, awsOffset) {
      this.awsData = awsData;
      this.awsOffset = awsOffset;
      this.awsEnd = awsOffset + awsData.length;
      this.metadataCache = new Map();
    }

    async getBytes(offset, size) {
      // Serve data from our fetched buffer
      if (offset >= this.awsOffset && offset + size <= this.awsEnd) {
        const localOffset = offset - this.awsOffset;
        return new Uint8Array(this.awsData.slice(localOffset, localOffset + size));
      }
      // For metadata, fetch from AWS (should be cached by browser)
      const response = await fetch(AWS_URL, {
        headers: { Range: `bytes=${offset}-${offset + size - 1}` }
      });
      return new Uint8Array(await response.arrayBuffer());
    }

    async count() {
      return fileSize;
    }
  }

  const memBackend = new MemoryBackend(awsData, minOffset);
  const reader2 = await OmFileReader.create(memBackend);

  let tempVar2 = null;
  for (let i = 0; i < reader2.numberOfChildren(); i++) {
    const child = await reader2.getChild(i);
    if (child.getName() === PARAM) {
      tempVar2 = child;
      break;
    }
  }

  const decodeT0 = performance.now();
  const fullData = await tempVar2.read({
    type: OmDataType.FloatArray,
    ranges: [
      { start: 0, end: dims[0] },
      { start: 0, end: totalPoints }
    ]
  });

  console.log(`  Decoded ${fullData.length.toLocaleString()} values in ${(performance.now() - decodeT0).toFixed(0)}ms`);

  // Stats
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < fullData.length; i++) {
    if (fullData[i] < min) min = fullData[i];
    if (fullData[i] > max) max = fullData[i];
  }
  console.log(`  Range: ${min.toFixed(1)}°C to ${max.toFixed(1)}°C`);

  // Save
  const binPath = `./data/poc-${NUM_SLICES}slices.temp.bin`;
  writeFileSync(binPath, Buffer.from(fullData.buffer));

  const totalTime = ((performance.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== Summary ===`);
  console.log(`  Total time: ${totalTime}s`);
  console.log(`  Init requests: ${initRequestCount}`);
  console.log(`  Data requests: ${dataRequests}`);
  console.log(`  Total requests: ${requestCount}`);
  console.log(`  Saved: ${binPath}`);
  console.log(`\nTo create PNG: source ../venv/bin/activate && python temp-to-png.py ${binPath}`);
}

main().catch(console.error);
