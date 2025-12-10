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

import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { initWasm } from '@openmeteo/file-reader';

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

// Model runs: 00, 06, 12, 18
const MODEL_RUNS = ['00', '06', '12', '18'];

function buildUrl(year, month, day, runHour, targetDatetime) {
  return `https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs/${year}/${month}/${day}/${runHour}00Z/${targetDatetime}.om`;
}

async function checkUrl(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

async function findLatestRun(year, month, day, hour, param) {
  const targetDatetime = `${year}-${month}-${day}T${hour}00`;
  const targetDate = new Date(`${year}-${month}-${day}T${hour}:00:00Z`);

  console.log(`Looking for: ${targetDatetime}`);

  // Try model runs from target date going backwards
  for (let daysBack = 0; daysBack <= 10; daysBack++) {
    const runDate = new Date(targetDate.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const runYear = runDate.getUTCFullYear();
    const runMonth = String(runDate.getUTCMonth() + 1).padStart(2, '0');
    const runDay = String(runDate.getUTCDate()).padStart(2, '0');

    // Try each model run (reverse order: 18, 12, 06, 00)
    for (const runHour of [...MODEL_RUNS].reverse()) {
      const runTime = new Date(`${runYear}-${runMonth}-${runDay}T${runHour}:00:00Z`);

      // Skip if run is after target time
      if (runTime > targetDate) continue;

      // Check forecast horizon (max ~10 days = 240 hours)
      const hoursAhead = (targetDate - runTime) / (1000 * 60 * 60);
      if (hoursAhead > 240) continue;

      const url = buildUrl(runYear, runMonth, runDay, runHour, targetDatetime);
      console.log(`  Checking: ${url}`);

      if (await checkUrl(url)) {
        console.log(`  Found!`);
        return { url, runYear, runMonth, runDay, runHour };
      }
    }
  }

  return null;
}

async function findAvailableRange(runYear, runMonth, runDay, runHour) {
  const baseUrl = `https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs/${runYear}/${runMonth}/${runDay}/${runHour}00Z`;

  // Find earliest and latest available
  const runDate = new Date(`${runYear}-${runMonth}-${runDay}T${runHour}:00:00Z`);

  let earliest = null;
  let latest = null;

  // Check hours from run time to +240h
  for (let h = 0; h <= 240; h++) {
    const dt = new Date(runDate.getTime() + h * 60 * 60 * 1000);
    const dtStr = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}T${String(dt.getUTCHours()).padStart(2, '0')}00`;
    const url = `${baseUrl}/${dtStr}.om`;

    if (await checkUrl(url)) {
      if (!earliest) earliest = dtStr;
      latest = dtStr;
    } else if (earliest) {
      // Gap found, stop
      break;
    }
  }

  return { earliest, latest };
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
  console.log(`Slices: ${slices}`);

  const t0 = performance.now();

  // Find latest model run
  const run = await findLatestRun(year, month, day, hour, param);

  if (!run) {
    console.log(`\nNo data found for ${datetime}`);

    // Try to find available range from latest run
    const today = new Date();
    const runYear = today.getUTCFullYear();
    const runMonth = String(today.getUTCMonth() + 1).padStart(2, '0');
    const runDay = String(today.getUTCDate()).padStart(2, '0');

    for (const runHour of [...MODEL_RUNS].reverse()) {
      const testUrl = buildUrl(runYear, runMonth, runDay, runHour, `${runYear}-${runMonth}-${runDay}T${runHour}00`);
      console.log(`  Checking run ${runYear}-${runMonth}-${runDay} ${runHour}Z...`);
      if (await checkUrl(testUrl)) {
        const range = await findAvailableRange(runYear, runMonth, runDay, runHour);
        console.log(`\nAvailable range for ${runHour}Z run:`);
        console.log(`  Earliest: ${range.earliest}`);
        console.log(`  Latest: ${range.latest}`);
        break;
      }
    }
    process.exit(1);
  }

  // Process
  const data = await processOmFile(run.url, param, slices);

  // Save bin
  const binPath = `./data/${datetime}-${param}-${slices}slices.bin`;
  writeFileSync(binPath, Buffer.from(data.buffer));

  const totalTime = ((performance.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== Summary ===`);
  console.log(`  Time: ${totalTime}s`);
  console.log(`  Requests: ${requestCount}`);
  console.log(`  Saved: ${binPath}`);

  // Generate PNG
  console.log('\nGenerating PNG...');
  const pythonCmd = `source /Users/noiv/Projects/hypatia/venv/bin/activate && python /Users/noiv/Projects/hypatia/zero/test/temp-to-png.py ${binPath}`;
  execSync(pythonCmd, { shell: '/bin/bash', stdio: 'inherit' });
}

main().catch(console.error);
