/**
 * PoC: Direct WASM decode of .om file
 *
 * Step 1: Load entire .om file, decode via lib's WASM, output .bin
 * Step 2: Read in 10 continuous chunks, simulating streaming
 *
 * Usage: node stream-decode.js [local|aws]
 */

import { readFileSync, writeFileSync } from 'fs';
import { OmFileReader, OmHttpBackend, OmDataType } from '@openmeteo/file-reader';

const NUM_CHUNKS = 10;
const AWS_URL = 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs/2025/12/10/0000Z/2025-12-10T0600.om';

// Use local file backend
class OmFileBackend {
  constructor(buffer) {
    this.buffer = buffer;
  }

  async getBytes(offset, size) {
    return new Uint8Array(this.buffer.slice(offset, offset + size));
  }

  async count() {
    return this.buffer.length;
  }
}

async function main() {
  const useAws = process.argv[2] === 'aws';
  const outPath = useAws ? './data/sample-02-aws.temp.bin' : './data/sample-01.temp.bin';

  console.log(`=== PoC: Chunked Range Reads (${useAws ? 'AWS' : 'Local'}) ===\n`);

  let backend;
  const t0 = performance.now();

  if (useAws) {
    console.log(`Using AWS: ${AWS_URL}`);
    backend = new OmHttpBackend({ url: AWS_URL });
  } else {
    const omPath = './data/sample.om';
    console.log(`Loading: ${omPath}`);
    const fileBuffer = readFileSync(omPath);
    console.log(`  Size: ${(fileBuffer.length / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  Loaded in ${(performance.now() - t0).toFixed(0)}ms`);
    backend = new OmFileBackend(fileBuffer);
  }

  // Create reader
  const reader = await OmFileReader.create(backend);
  if (useAws) {
    console.log(`  Connected in ${(performance.now() - t0).toFixed(0)}ms`);
  }

  // Step 3: Find temperature variable
  const numChildren = reader.numberOfChildren();
  console.log(`\nVariables: ${numChildren}`);

  let tempVar = null;
  for (let i = 0; i < numChildren; i++) {
    const child = await reader.getChild(i);
    const name = child.getName();
    if (name === 'temperature_2m' || name === 'temperature') {
      tempVar = child;
      console.log(`  Found: ${name}`);
      break;
    }
  }

  if (!tempVar) {
    throw new Error('No temperature variable found');
  }

  const dims = tempVar.getDimensions();
  const totalPoints = dims[1];
  console.log(`  Dims: [${dims.join(', ')}]`);
  console.log(`  Total: ${totalPoints.toLocaleString()} values`);

  // Step 4: Read in NUM_CHUNKS continuous range reads
  console.log(`\nDecoding in ${NUM_CHUNKS} chunks...`);
  const t1 = performance.now();

  const chunkSize = Math.ceil(totalPoints / NUM_CHUNKS);
  const fullData = new Float32Array(totalPoints);

  for (let i = 0; i < NUM_CHUNKS; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, totalPoints);

    console.log(`  Chunk ${i + 1}/${NUM_CHUNKS}: [${start.toLocaleString()} - ${end.toLocaleString()}]`);

    const chunkData = await tempVar.read({
      type: OmDataType.FloatArray,
      ranges: [
        { start: 0, end: dims[0] },
        { start: start, end: end }
      ]
    });

    // Copy into full array
    fullData.set(chunkData, start);
  }

  console.log(`  Total decode time: ${(performance.now() - t1).toFixed(0)}ms`);

  // Stats
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < fullData.length; i++) {
    if (fullData[i] < min) min = fullData[i];
    if (fullData[i] > max) max = fullData[i];
  }
  console.log(`  Range: ${min.toFixed(1)}°C to ${max.toFixed(1)}°C`);

  // Step 5: Write output
  writeFileSync(outPath, Buffer.from(fullData.buffer));
  console.log(`\nSaved: ${outPath} (${(fullData.byteLength / 1024 / 1024).toFixed(1)} MB)`);

  console.log('\n=== Done ===');
  console.log(`Run: source ../venv/bin/activate && python temp-to-png.py ${outPath}`);
}

main().catch(console.error);
