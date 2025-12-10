#!/usr/bin/env node
/**
 * Render PNG from Open-Meteo .om files
 *
 * Usage: node render-png-from-om.js [datetime] [param] [slices]
 *
 * Args:
 *   datetime: YYYY-MM-DD-HH format, default is current hour
 *   param:    variable name, default is temperature_2m
 *   slices:   1-30, default is 10
 *
 * Example: node render-png-from-om.js 2025-12-10-03 precipitation 10
 */

import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { initWasm } from '@openmeteo/file-reader';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

// Parse args
function parseArgs() {
  const now = new Date();
  const defaultDatetime = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}`;

  const datetime = process.argv[2] || defaultDatetime;
  const param = process.argv[3] || 'temperature_2m';
  const slices = Math.max(1, Math.min(30, parseInt(process.argv[4] || '10', 10)));

  // Parse datetime
  const match = datetime.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})$/);
  if (!match) {
    console.error(`Invalid datetime format: ${datetime}`);
    console.error('Expected: YYYY-MM-DD-HH (e.g., 2025-12-10-03)');
    process.exit(1);
  }

  const [, year, month, day, hour] = match;
  return { year, month, day, hour, param, slices, datetime };
}

const BASE_URL = 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs';
const S3_BUCKET = 'https://openmeteo.s3.amazonaws.com';

async function listS3Prefixes(prefix) {
  const url = `${S3_BUCKET}/?list-type=2&prefix=${prefix}&delimiter=/`;
  const response = await fetch(url);
  const text = await response.text();
  const matches = text.match(/<Prefix>[^<]+<\/Prefix>/g) || [];
  return matches.map(m => m.replace(/<\/?Prefix>/g, ''));
}

async function getAvailableRuns() {
  // Get all available runs from S3 listing
  const runs = [];

  // List years (just 2025 for now)
  const months = await listS3Prefixes('data_spatial/ecmwf_ifs/2025/');

  for (const monthPrefix of months) {
    if (!monthPrefix.match(/\/\d{2}\/$/)) continue;
    const days = await listS3Prefixes(monthPrefix);

    for (const dayPrefix of days) {
      if (!dayPrefix.match(/\/\d{2}\/$/)) continue;
      const runDirs = await listS3Prefixes(dayPrefix);

      for (const runDir of runDirs) {
        const match = runDir.match(/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})00Z\/$/);
        if (match) {
          const [, year, month, day, hour] = match;
          runs.push({ year, month, day, hour, prefix: runDir });
        }
      }
    }
  }

  // Sort by date descending
  runs.sort((a, b) => {
    const dateA = `${a.year}${a.month}${a.day}${a.hour}`;
    const dateB = `${b.year}${b.month}${b.day}${b.hour}`;
    return dateB.localeCompare(dateA);
  });

  return runs;
}

async function findRun(datetime, param) {
  const targetDatetime = `${datetime.replace(/-(\d{2})$/, 'T$100')}`;  // "2025-12-10-06" -> "2025-12-10T0600"
  const targetDate = new Date(datetime.replace(/-(\d{2})$/, 'T$1:00:00Z'));

  console.log(`Looking for: ${targetDatetime}`);
  console.log(`Listing S3 bucket...`);

  const runs = await getAvailableRuns();

  if (runs.length === 0) {
    console.log('No runs found in bucket!');
    process.exit(1);
  }

  // Log earliest and latest run
  const latestRun = runs[0];
  const earliestRun = runs[runs.length - 1];
  console.log(`  Earliest run: ${earliestRun.year}-${earliestRun.month}-${earliestRun.day} ${earliestRun.hour}Z`);
  console.log(`  Latest run:   ${latestRun.year}-${latestRun.month}-${latestRun.day} ${latestRun.hour}Z`);

  // Find a run that covers the target datetime
  for (const run of runs) {
    const runTime = new Date(`${run.year}-${run.month}-${run.day}T${run.hour}:00:00Z`);

    // Run must be before or at target time
    if (runTime > targetDate) continue;

    // Check forecast horizon (max ~10 days = 240 hours)
    const hoursAhead = (targetDate - runTime) / (1000 * 60 * 60);
    if (hoursAhead > 240) continue;

    // Check if file exists
    const url = `${BASE_URL}/${run.year}/${run.month}/${run.day}/${run.hour}00Z/${targetDatetime}.om`;
    const response = await fetch(url, { method: 'HEAD' });

    if (response.ok) {
      console.log(`  Found: ${run.year}-${run.month}-${run.day} ${run.hour}Z run`);
      console.log(`  URL: ${url}`);
      return { url, ...run };
    }
  }

  console.log(`\nNot available: ${datetime}`);
  process.exit(1);
}

let requestCount = 0;

async function fetchRange(url, offset, size, label) {
  requestCount++;
  const rangeHeader = `bytes=${offset}-${offset + size - 1}`;
  console.log(`  [${label}] #${requestCount}: Range ${rangeHeader} (${size.toLocaleString()} bytes)`);

  const response = await fetch(url, {
    headers: { Range: rangeHeader }
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function processOmFile(url, param, slices) {
  const wasm = await initWasm();

  // Phase 1: HEAD
  console.log('\nPhase 1: File size');
  requestCount++;
  console.log(`  [HEAD] #${requestCount}: ${url}`);
  const headResponse = await fetch(url, { method: 'HEAD' });
  if (!headResponse.ok) throw new Error(`File not found: ${url}`);
  const fileSize = parseInt(headResponse.headers.get('content-length'), 10);
  console.log(`  Size: ${fileSize.toLocaleString()} bytes`);

  // Phase 2: Trailer
  console.log('\nPhase 2: Trailer');
  const trailerSize = wasm.om_trailer_size();
  const trailerOffset = fileSize - trailerSize;
  const trailerData = await fetchRange(url, trailerOffset, trailerSize, 'TRAILER');

  const trailerPtr = wasm._malloc(trailerSize);
  wasm.HEAPU8.set(trailerData, trailerPtr);
  const offsetPtr = wasm._malloc(8);
  const sizePtr = wasm._malloc(8);

  if (!wasm.om_trailer_read(trailerPtr, offsetPtr, sizePtr)) throw new Error('Failed to read trailer');

  const rootOffset = Number(wasm.getValue(offsetPtr, 'i64'));
  const rootSize = Number(wasm.getValue(sizePtr, 'i64'));
  wasm._free(trailerPtr);
  wasm._free(offsetPtr);
  wasm._free(sizePtr);

  // Phase 3: Root + children
  console.log('\nPhase 3: Root + children metadata');
  const rootData = await fetchRange(url, rootOffset, rootSize, 'ROOT');

  const rootPtr = wasm._malloc(rootData.length);
  wasm.HEAPU8.set(rootData, rootPtr);
  const rootVar = wasm.om_variable_init(rootPtr);
  if (!rootVar) throw new Error('Failed to init root variable');

  const numChildren = wasm.om_variable_get_children_count(rootVar);

  // Get all children offsets
  const o1Ptr = wasm._malloc(8);
  const s1Ptr = wasm._malloc(8);
  let childrenStart = Infinity, childrenEnd = 0;
  const childMeta = [];

  for (let i = 0; i < numChildren; i++) {
    wasm.om_variable_get_children(rootVar, i, 1, o1Ptr, s1Ptr);
    const offset = Number(wasm.getValue(o1Ptr, 'i64'));
    const size = Number(wasm.getValue(s1Ptr, 'i64'));
    childMeta.push({ index: i, offset, size });
    if (offset < childrenStart) childrenStart = offset;
    if (offset + size > childrenEnd) childrenEnd = offset + size;
  }

  wasm._free(o1Ptr);
  wasm._free(s1Ptr);

  const allChildrenData = await fetchRange(url, childrenStart, childrenEnd - childrenStart, 'CHILDREN');

  // Phase 4: Find param
  console.log(`\nPhase 4: Find ${param}`);

  const availableParams = [];
  let targetVarOffset = null, targetVarSize = null, targetDims = null;

  const childOffsetPtr = wasm._malloc(8);
  const childSizePtr = wasm._malloc(8);

  for (let i = 0; i < numChildren; i++) {
    wasm.om_variable_get_children(rootVar, i, 1, childOffsetPtr, childSizePtr);
    const childOffset = Number(wasm.getValue(childOffsetPtr, 'i64'));
    const childSize = Number(wasm.getValue(childSizePtr, 'i64'));

    const localOffset = childOffset - childrenStart;
    const childData = allChildrenData.slice(localOffset, localOffset + childSize);

    const childPtr = wasm._malloc(childData.length);
    wasm.HEAPU8.set(childData, childPtr);
    const childVar = wasm.om_variable_init(childPtr);

    const lengthPtr = wasm._malloc(2);
    const namePtr = wasm.om_variable_get_name_ptr(childVar, lengthPtr);
    const nameLen = wasm.getValue(lengthPtr, 'i16');
    wasm._free(lengthPtr);

    if (nameLen > 0) {
      const nameBytes = wasm.HEAPU8.subarray(namePtr, namePtr + nameLen);
      const name = new TextDecoder().decode(nameBytes);
      availableParams.push(name);

      if (name === param) {
        targetVarOffset = childOffset;
        targetVarSize = childSize;
        const dimCount = Number(wasm.om_variable_get_dimensions_count(childVar));
        const dimsPtr = wasm.om_variable_get_dimensions_ptr(childVar);
        const int64View = new BigInt64Array(wasm.HEAPU8.buffer, dimsPtr, dimCount);
        targetDims = Array.from(int64View, v => Number(v));
      }
    }
    wasm._free(childPtr);
  }

  wasm._free(childOffsetPtr);
  wasm._free(childSizePtr);
  wasm._free(rootPtr);

  if (!targetVarOffset) {
    console.log(`\nParameter '${param}' not found!`);
    console.log('\nAvailable parameters:');
    availableParams.forEach(p => console.log(`  ${p}`));
    process.exit(1);
  }

  console.log(`  Found: ${param}, dims=[${targetDims.join(',')}]`);

  // Phase 5: Discover data range
  console.log('\nPhase 5: Discover data range');

  const targetChildData = allChildrenData.slice(
    targetVarOffset - childrenStart,
    targetVarOffset - childrenStart + targetVarSize
  );

  const targetPtr = wasm._malloc(targetChildData.length);
  wasm.HEAPU8.set(targetChildData, targetPtr);
  const targetVar = wasm.om_variable_init(targetPtr);

  const nDims = targetDims.length;
  const readOffsetPtr = wasm._malloc(nDims * 8);
  const readCountPtr = wasm._malloc(nDims * 8);
  const cubeOffsetPtr = wasm._malloc(nDims * 8);
  const cubeDimPtr = wasm._malloc(nDims * 8);

  for (let i = 0; i < nDims; i++) {
    wasm.setValue(readOffsetPtr + i * 8, BigInt(0), 'i64');
    wasm.setValue(readCountPtr + i * 8, BigInt(targetDims[i]), 'i64');
    wasm.setValue(cubeOffsetPtr + i * 8, BigInt(0), 'i64');
    wasm.setValue(cubeDimPtr + i * 8, BigInt(targetDims[i]), 'i64');
  }

  const decoderPtr = wasm._malloc(wasm.sizeof_decoder);
  const error = wasm.om_decoder_init(
    decoderPtr, targetVar, BigInt(nDims),
    readOffsetPtr, readCountPtr, cubeOffsetPtr, cubeDimPtr,
    BigInt(2048), BigInt(65536)
  );
  if (error !== wasm.ERROR_OK) throw new Error(`Decoder init failed: ${error}`);

  const indexReadPtr = wasm._malloc(64);
  wasm.om_decoder_init_index_read(decoderPtr, indexReadPtr);
  const errorPtr = wasm._malloc(4);
  wasm.setValue(errorPtr, wasm.ERROR_OK, 'i32');

  let minDataOffset = Infinity, maxDataEnd = 0;
  const indexBlocks = [];

  while (wasm.om_decoder_next_index_read(decoderPtr, indexReadPtr)) {
    const indexOffset = Number(wasm.getValue(indexReadPtr, 'i64'));
    const indexCount = Number(wasm.getValue(indexReadPtr + 8, 'i64'));

    const indexData = await fetchRange(url, indexOffset, indexCount, `INDEX`);
    indexBlocks.push({ offset: indexOffset, count: indexCount, data: indexData });

    const indexDataPtr = wasm._malloc(indexData.length);
    wasm.HEAPU8.set(indexData, indexDataPtr);

    const dataReadPtr = wasm._malloc(64);
    wasm.om_decoder_init_data_read(dataReadPtr, indexReadPtr);

    while (wasm.om_decoder_next_data_read(decoderPtr, dataReadPtr, indexDataPtr, BigInt(indexCount), errorPtr)) {
      const dataOffset = Number(wasm.getValue(dataReadPtr, 'i64'));
      const dataCount = Number(wasm.getValue(dataReadPtr + 8, 'i64'));
      if (dataOffset < minDataOffset) minDataOffset = dataOffset;
      if (dataOffset + dataCount > maxDataEnd) maxDataEnd = dataOffset + dataCount;
    }

    wasm._free(indexDataPtr);
    wasm._free(dataReadPtr);
  }

  const totalCompressed = maxDataEnd - minDataOffset;
  console.log(`  Data range: ${(totalCompressed / 1024 / 1024).toFixed(2)} MB`);

  // Phase 6: Fetch data slices
  console.log(`\nPhase 6: Fetch ${slices} data slices`);

  const sliceBytes = Math.ceil(totalCompressed / slices);
  const allDataBuffer = new Uint8Array(totalCompressed);

  for (let i = 0; i < slices; i++) {
    const sliceStart = i * sliceBytes;
    const sliceEnd = Math.min(sliceStart + sliceBytes, totalCompressed);
    const sliceSize = sliceEnd - sliceStart;
    const awsOffset = minDataOffset + sliceStart;
    const data = await fetchRange(url, awsOffset, sliceSize, `DATA-${i + 1}`);
    allDataBuffer.set(data, sliceStart);
  }

  // Phase 7: Decode
  console.log('\nPhase 7: Decode');

  const outputElements = targetDims.reduce((a, b) => a * b, 1);
  const outputPtr = wasm._malloc(outputElements * 4);
  const chunkBufferSize = Number(wasm.om_decoder_read_buffer_size(decoderPtr));
  const chunkBufferPtr = wasm._malloc(chunkBufferSize);

  const decoder2Ptr = wasm._malloc(wasm.sizeof_decoder);
  wasm.om_decoder_init(
    decoder2Ptr, targetVar, BigInt(nDims),
    readOffsetPtr, readCountPtr, cubeOffsetPtr, cubeDimPtr,
    BigInt(2048), BigInt(65536)
  );

  const indexRead2Ptr = wasm._malloc(64);
  wasm.om_decoder_init_index_read(decoder2Ptr, indexRead2Ptr);

  let blockIdx = 0;
  while (wasm.om_decoder_next_index_read(decoder2Ptr, indexRead2Ptr)) {
    const { data: indexData, count: indexCount } = indexBlocks[blockIdx++];

    const indexDataPtr = wasm._malloc(indexData.length);
    wasm.HEAPU8.set(indexData, indexDataPtr);

    const dataRead2Ptr = wasm._malloc(64);
    wasm.om_decoder_init_data_read(dataRead2Ptr, indexRead2Ptr);

    while (wasm.om_decoder_next_data_read(decoder2Ptr, dataRead2Ptr, indexDataPtr, BigInt(indexCount), errorPtr)) {
      const dataOffset = Number(wasm.getValue(dataRead2Ptr, 'i64'));
      const dataCount = Number(wasm.getValue(dataRead2Ptr + 8, 'i64'));
      const chunkIndexPtr = dataRead2Ptr + 32;

      const localOffset = dataOffset - minDataOffset;
      const chunkData = allDataBuffer.slice(localOffset, localOffset + dataCount);

      const dataBlockPtr = wasm._malloc(chunkData.length);
      wasm.HEAPU8.set(chunkData, dataBlockPtr);

      if (!wasm.om_decoder_decode_chunks(
        decoder2Ptr, chunkIndexPtr, dataBlockPtr, BigInt(dataCount),
        outputPtr, chunkBufferPtr, errorPtr
      )) {
        throw new Error(`Decode failed: ${wasm.getValue(errorPtr, 'i32')}`);
      }

      wasm._free(dataBlockPtr);
    }

    wasm._free(indexDataPtr);
    wasm._free(dataRead2Ptr);
  }

  const result = new Float32Array(outputElements);
  result.set(new Float32Array(wasm.HEAPU8.buffer, outputPtr, outputElements));

  // Cleanup
  wasm._free(outputPtr);
  wasm._free(chunkBufferPtr);
  wasm._free(decoder2Ptr);
  wasm._free(indexRead2Ptr);
  wasm._free(decoderPtr);
  wasm._free(indexReadPtr);
  wasm._free(errorPtr);
  wasm._free(readOffsetPtr);
  wasm._free(readCountPtr);
  wasm._free(cubeOffsetPtr);
  wasm._free(cubeDimPtr);
  wasm._free(targetPtr);

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < result.length; i++) {
    if (result[i] < min) min = result[i];
    if (result[i] > max) max = result[i];
  }
  console.log(`  Decoded ${result.length.toLocaleString()} values, range: ${min.toFixed(2)} to ${max.toFixed(2)}`);

  return result;
}

async function main() {
  const { year, month, day, hour, param, slices, datetime } = parseArgs();

  console.log(`=== Render PNG from Open-Meteo ===\n`);
  console.log(`Datetime: ${datetime}`);
  console.log(`Param: ${param}`);
  console.log(`Slices: ${slices}\n`);

  const t0 = performance.now();

  // Find model run (exits if not found)
  const run = await findRun(datetime, param);

  // Process
  const data = await processOmFile(run.url, param, slices);

  // Save bin
  const binPath = join(DATA_DIR, `${datetime}-${param}-${slices}slices.bin`);
  writeFileSync(binPath, Buffer.from(data.buffer));

  const totalTime = ((performance.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== Summary ===`);
  console.log(`  Time: ${totalTime}s`);
  console.log(`  Requests: ${requestCount}`);
  console.log(`  Saved: ${binPath}`);

  // Generate PNG
  console.log('\nGenerating PNG...');
  const pythonScript = join(__dirname, 'temp-to-png.py');
  const pythonCmd = `source /Users/noiv/Projects/hypatia/venv/bin/activate && python ${pythonScript} ${binPath}`;
  execSync(pythonCmd, { shell: '/bin/bash', stdio: 'inherit' });
}

main().catch(console.error);
