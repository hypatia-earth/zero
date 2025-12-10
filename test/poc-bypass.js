/**
 * PoC: Bypass lib completely for minimal AWS requests
 *
 * Target: 5 init requests + N data slices = 5+N total
 *
 * Strategy:
 * 1. HEAD request → file size
 * 2. Fetch trailer (24 bytes) → root offset/size
 * 3. Fetch root + ALL children metadata in ONE request
 * 4. Parse locally to find temperature_2m
 * 5. Fetch data in N slices
 * 6. Decode with WASM
 */

import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { initWasm } from '@openmeteo/file-reader';

const NUM_SLICES = parseInt(process.argv[2] || '10', 10);
const PARAM = process.argv[3] || 'temperature_2m';
const AWS_URL = 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs/2025/12/10/0000Z/2025-12-10T0600.om';

let requestCount = 0;

async function fetchRange(offset, size, label) {
  requestCount++;
  const rangeHeader = `bytes=${offset}-${offset + size - 1}`;
  console.log(`  [${label}] #${requestCount}: Range ${rangeHeader} (${size.toLocaleString()} bytes)`);

  const response = await fetch(AWS_URL, {
    headers: { Range: rangeHeader }
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function main() {
  console.log('=== PoC: Bypass Lib (Direct WASM) ===\n');
  console.log(`Target: ${5 + NUM_SLICES} requests (5 init + ${NUM_SLICES} data)`);
  console.log(`URL: ${AWS_URL}\n`);

  const t0 = performance.now();

  // Init WASM
  const wasm = await initWasm();

  // === Phase 1: Get file size (HEAD request) ===
  console.log('Phase 1: File size');
  requestCount++;
  console.log(`  [HEAD] #${requestCount}: ${AWS_URL}`);
  const headResponse = await fetch(AWS_URL, { method: 'HEAD' });
  const fileSize = parseInt(headResponse.headers.get('content-length'), 10);
  console.log(`  File size: ${fileSize.toLocaleString()} bytes`);

  // === Phase 2: Fetch trailer (24 bytes at end) ===
  console.log('\nPhase 2: Trailer');
  const trailerSize = wasm.om_trailer_size();
  const trailerOffset = fileSize - trailerSize;
  const trailerData = await fetchRange(trailerOffset, trailerSize, 'TRAILER');

  // Parse trailer to get root offset/size
  const trailerPtr = wasm._malloc(trailerSize);
  wasm.HEAPU8.set(trailerData, trailerPtr);

  const offsetPtr = wasm._malloc(8);
  const sizePtr = wasm._malloc(8);

  const success = wasm.om_trailer_read(trailerPtr, offsetPtr, sizePtr);
  if (!success) throw new Error('Failed to read trailer');

  const rootOffset = Number(wasm.getValue(offsetPtr, 'i64'));
  const rootSize = Number(wasm.getValue(sizePtr, 'i64'));

  wasm._free(trailerPtr);
  wasm._free(offsetPtr);
  wasm._free(sizePtr);

  console.log(`  Root: offset=${rootOffset.toLocaleString()}, size=${rootSize.toLocaleString()}`);

  // === Phase 3: Fetch root + estimate children metadata range ===
  // The children metadata should be contiguous after the root
  // Fetch a larger chunk that includes root + all children metadata
  console.log('\nPhase 3: Root + children metadata');

  // First fetch just the root to find out how many children
  const rootData = await fetchRange(rootOffset, rootSize, 'ROOT');

  const rootPtr = wasm._malloc(rootData.length);
  wasm.HEAPU8.set(rootData, rootPtr);
  const rootVar = wasm.om_variable_init(rootPtr);

  if (!rootVar) throw new Error('Failed to init root variable');

  const numChildren = wasm.om_variable_get_children_count(rootVar);
  console.log(`  Children: ${numChildren}`);

  // Get offsets of ALL children to find min/max range
  const o1Ptr = wasm._malloc(8);
  const s1Ptr = wasm._malloc(8);

  let childrenStart = Infinity;
  let childrenEnd = 0;

  // Scan all children to find actual byte range (they may not be contiguous/ordered)
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

  const childrenTotalSize = childrenEnd - childrenStart;

  console.log(`  Children range: ${childrenStart.toLocaleString()} - ${childrenEnd.toLocaleString()} (${childrenTotalSize.toLocaleString()} bytes)`);

  // Fetch ALL children metadata in ONE request
  const allChildrenData = await fetchRange(childrenStart, childrenTotalSize, 'CHILDREN');

  // === Phase 4: Find temperature_2m locally ===
  console.log('\nPhase 4: Find temperature_2m');

  let tempVarOffset = null;
  let tempVarSize = null;
  let tempDims = null;

  const childOffsetPtr = wasm._malloc(8);
  const childSizePtr = wasm._malloc(8);

  for (let i = 0; i < numChildren; i++) {
    wasm.om_variable_get_children(rootVar, i, 1, childOffsetPtr, childSizePtr);
    const childOffset = Number(wasm.getValue(childOffsetPtr, 'i64'));
    const childSize = Number(wasm.getValue(childSizePtr, 'i64'));

    // Get child data from our fetched buffer
    const localOffset = childOffset - childrenStart;
    const childData = allChildrenData.slice(localOffset, localOffset + childSize);

    const childPtr = wasm._malloc(childData.length);
    wasm.HEAPU8.set(childData, childPtr);
    const childVar = wasm.om_variable_init(childPtr);

    // Get name
    const lengthPtr = wasm._malloc(2);
    const namePtr = wasm.om_variable_get_name_ptr(childVar, lengthPtr);
    const nameLen = wasm.getValue(lengthPtr, 'i16');
    wasm._free(lengthPtr);

    if (nameLen > 0) {
      const nameBytes = wasm.HEAPU8.subarray(namePtr, namePtr + nameLen);
      const name = new TextDecoder().decode(nameBytes);

      if (name === PARAM) {
        tempVarOffset = childOffset;
        tempVarSize = childSize;

        // Get dimensions
        const dimCount = Number(wasm.om_variable_get_dimensions_count(childVar));
        const dimsPtr = wasm.om_variable_get_dimensions_ptr(childVar);
        const int64View = new BigInt64Array(wasm.HEAPU8.buffer, dimsPtr, dimCount);
        tempDims = Array.from(int64View, v => Number(v));

        console.log(`  Found: ${name}, dims=[${tempDims.join(',')}]`);
        wasm._free(childPtr);
        break;
      }
    }

    wasm._free(childPtr);
  }

  wasm._free(childOffsetPtr);
  wasm._free(childSizePtr);
  wasm._free(rootPtr);

  if (!tempVarOffset) throw new Error(`Variable ${PARAM} not found`);

  const totalPoints = tempDims[1];

  // === Phase 5: Discover data chunk locations ===
  // We need to do ONE read to discover where the data chunks are
  // Then we can fetch them in N slices
  console.log('\nPhase 5: Discover data chunk range');

  // Re-init temp variable for decoding
  const tempChildData = allChildrenData.slice(
    tempVarOffset - childrenStart,
    tempVarOffset - childrenStart + tempVarSize
  );

  const tempPtr = wasm._malloc(tempChildData.length);
  wasm.HEAPU8.set(tempChildData, tempPtr);
  const tempVar = wasm.om_variable_init(tempPtr);

  // Setup decoder to find data ranges
  const nDims = tempDims.length;
  const readOffsetPtr = wasm._malloc(nDims * 8);
  const readCountPtr = wasm._malloc(nDims * 8);
  const cubeOffsetPtr = wasm._malloc(nDims * 8);
  const cubeDimPtr = wasm._malloc(nDims * 8);

  for (let i = 0; i < nDims; i++) {
    wasm.setValue(readOffsetPtr + i * 8, BigInt(0), 'i64');
    wasm.setValue(readCountPtr + i * 8, BigInt(tempDims[i]), 'i64');
    wasm.setValue(cubeOffsetPtr + i * 8, BigInt(0), 'i64');
    wasm.setValue(cubeDimPtr + i * 8, BigInt(tempDims[i]), 'i64');
  }

  const decoderPtr = wasm._malloc(wasm.sizeof_decoder);
  const error = wasm.om_decoder_init(
    decoderPtr, tempVar, BigInt(nDims),
    readOffsetPtr, readCountPtr, cubeOffsetPtr, cubeDimPtr,
    BigInt(2048), BigInt(65536)
  );

  if (error !== wasm.ERROR_OK) throw new Error(`Decoder init failed: ${error}`);

  // Iterate through decoder to find data ranges
  // We need to fetch index blocks to discover data block locations
  const indexReadPtr = wasm._malloc(64);
  wasm.om_decoder_init_index_read(decoderPtr, indexReadPtr);
  const errorPtr = wasm._malloc(4);
  wasm.setValue(errorPtr, wasm.ERROR_OK, 'i32');

  let minDataOffset = Infinity;
  let maxDataEnd = 0;
  let indexRequestsMade = 0;

  while (wasm.om_decoder_next_index_read(decoderPtr, indexReadPtr)) {
    const indexOffset = Number(wasm.getValue(indexReadPtr, 'i64'));
    const indexCount = Number(wasm.getValue(indexReadPtr + 8, 'i64'));

    // Fetch index block (this counts as init request)
    indexRequestsMade++;
    const indexData = await fetchRange(indexOffset, indexCount, `INDEX-${indexRequestsMade}`);

    const indexDataPtr = wasm._malloc(indexData.length);
    wasm.HEAPU8.set(indexData, indexDataPtr);

    const dataReadPtr = wasm._malloc(64);
    wasm.om_decoder_init_data_read(dataReadPtr, indexReadPtr);

    // Iterate data blocks to find range
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
  console.log(`  Data range: ${minDataOffset.toLocaleString()} - ${maxDataEnd.toLocaleString()} (${(totalCompressed / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  Index requests: ${indexRequestsMade}`);

  // === Phase 6: Fetch data in N slices ===
  console.log(`\nPhase 6: Fetch ${NUM_SLICES} data slices`);

  const sliceBytes = Math.ceil(totalCompressed / NUM_SLICES);
  const allDataBuffer = new Uint8Array(totalCompressed);

  for (let i = 0; i < NUM_SLICES; i++) {
    const sliceStart = i * sliceBytes;
    const sliceEnd = Math.min(sliceStart + sliceBytes, totalCompressed);
    const sliceSize = sliceEnd - sliceStart;
    const awsOffset = minDataOffset + sliceStart;

    const data = await fetchRange(awsOffset, sliceSize, `DATA-${i + 1}`);
    allDataBuffer.set(data, sliceStart);
  }

  // === Phase 7: Decode with WASM ===
  console.log('\nPhase 7: Decode');

  const decodeT0 = performance.now();
  const outputElements = tempDims.reduce((a, b) => a * b, 1);
  const outputPtr = wasm._malloc(outputElements * 4); // Float32
  const chunkBufferSize = Number(wasm.om_decoder_read_buffer_size(decoderPtr));
  const chunkBufferPtr = wasm._malloc(chunkBufferSize);

  // Re-init decoder for actual decode
  const decoder2Ptr = wasm._malloc(wasm.sizeof_decoder);
  wasm.om_decoder_init(
    decoder2Ptr, tempVar, BigInt(nDims),
    readOffsetPtr, readCountPtr, cubeOffsetPtr, cubeDimPtr,
    BigInt(2048), BigInt(65536)
  );

  const indexRead2Ptr = wasm._malloc(64);
  wasm.om_decoder_init_index_read(decoder2Ptr, indexRead2Ptr);

  // Decode loop - use cached data
  while (wasm.om_decoder_next_index_read(decoder2Ptr, indexRead2Ptr)) {
    const indexOffset = Number(wasm.getValue(indexRead2Ptr, 'i64'));
    const indexCount = Number(wasm.getValue(indexRead2Ptr + 8, 'i64'));

    // Fetch index (should be cached by browser... but we're in Node)
    // This is a limitation - in browser these would be cached
    const indexData = await fetchRange(indexOffset, indexCount, 'INDEX-DECODE');

    const indexDataPtr = wasm._malloc(indexData.length);
    wasm.HEAPU8.set(indexData, indexDataPtr);

    const dataRead2Ptr = wasm._malloc(64);
    wasm.om_decoder_init_data_read(dataRead2Ptr, indexRead2Ptr);

    while (wasm.om_decoder_next_data_read(decoder2Ptr, dataRead2Ptr, indexDataPtr, BigInt(indexCount), errorPtr)) {
      const dataOffset = Number(wasm.getValue(dataRead2Ptr, 'i64'));
      const dataCount = Number(wasm.getValue(dataRead2Ptr + 8, 'i64'));
      const chunkIndexPtr = dataRead2Ptr + 32;

      // Get data from our buffer
      const localOffset = dataOffset - minDataOffset;
      const chunkData = allDataBuffer.slice(localOffset, localOffset + dataCount);

      const dataBlockPtr = wasm._malloc(chunkData.length);
      wasm.HEAPU8.set(chunkData, dataBlockPtr);

      const decodeSuccess = wasm.om_decoder_decode_chunks(
        decoder2Ptr, chunkIndexPtr, dataBlockPtr, BigInt(dataCount),
        outputPtr, chunkBufferPtr, errorPtr
      );

      if (!decodeSuccess) {
        throw new Error(`Decode failed: ${wasm.getValue(errorPtr, 'i32')}`);
      }

      wasm._free(dataBlockPtr);
    }

    wasm._free(indexDataPtr);
    wasm._free(dataRead2Ptr);
  }

  // Copy output
  const result = new Float32Array(outputElements);
  result.set(new Float32Array(wasm.HEAPU8.buffer, outputPtr, outputElements));

  console.log(`  Decoded ${result.length.toLocaleString()} values in ${(performance.now() - decodeT0).toFixed(0)}ms`);

  // Stats
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < result.length; i++) {
    if (result[i] < min) min = result[i];
    if (result[i] > max) max = result[i];
  }
  console.log(`  Range: ${min.toFixed(1)}°C to ${max.toFixed(1)}°C`);

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
  wasm._free(tempPtr);

  // Save
  const binPath = `./data/poc-bypass-${NUM_SLICES}slices.${PARAM}.bin`;
  writeFileSync(binPath, Buffer.from(result.buffer));

  const totalTime = ((performance.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== Summary ===`);
  console.log(`  Total time: ${totalTime}s`);
  console.log(`  Total requests: ${requestCount}`);
  console.log(`  Target was: ${5 + NUM_SLICES}`);
  console.log(`  Saved: ${binPath}`);

  // Generate PNG
  console.log('\nGenerating PNG...');
  const pythonCmd = `source /Users/noiv/Projects/hypatia/venv/bin/activate && python /Users/noiv/Projects/hypatia/zero/test/temp-to-png.py ${binPath}`;
  execSync(pythonCmd, { shell: '/bin/bash', stdio: 'inherit' });
}

main().catch(console.error);
