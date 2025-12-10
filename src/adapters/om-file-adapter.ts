/**
 * OmFileAdapter - Direct WASM access to Open-Meteo .om files
 *
 * Fetches .om files via HTTP range requests and decodes using WASM.
 * Ported from working PoC: /zero/scripts/render-png-from-om.js
 */

// WASM module type - functions have underscore prefix
interface OmWasm {
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  getValue(ptr: number, type: string): number | bigint;
  setValue(ptr: number, value: number | bigint, type: string): void;

  _om_trailer_size(): number;
  _om_trailer_read(trailerPtr: number, offsetPtr: number, sizePtr: number): boolean;
  _om_variable_init(dataPtr: number): number;
  _om_variable_get_children_count(varPtr: number): number;
  _om_variable_get_children(varPtr: number, start: number, count: number, offsetPtr: number, sizePtr: number): void;
  _om_variable_get_name(varPtr: number, lengthPtr: number): number;
  _om_variable_get_dimensions_count(varPtr: number): number;
  _om_variable_get_dimensions(varPtr: number): number; // returns pointer to dims array
  _om_decoder_init(
    decoderPtr: number, varPtr: number, nDims: bigint,
    readOffset: number, readCount: number, cubeOffset: number, cubeDim: number,
    chunkSize: bigint, ioSize: bigint
  ): number;
  _om_decoder_init_index_read(decoderPtr: number, indexReadPtr: number): void;
  _om_decoder_next_index_read(decoderPtr: number, indexReadPtr: number): boolean;
  _om_decoder_init_data_read(dataReadPtr: number, indexReadPtr: number): void;
  _om_decoder_next_data_read(
    decoderPtr: number, dataReadPtr: number, indexDataPtr: number, indexCount: bigint, errorPtr: number
  ): boolean;
  _om_decoder_read_buffer_size(decoderPtr: number): bigint;
  _om_decoder_decode_chunks(
    decoderPtr: number, chunkIndexPtr: number, dataPtr: number, dataCount: bigint,
    outputPtr: number, bufferPtr: number, errorPtr: number
  ): boolean;
}

const SIZEOF_DECODER = 256;
const ERROR_OK = 0;

let wasmInstance: OmWasm | null = null;

export async function initOmWasm(): Promise<OmWasm> {
  if (wasmInstance) return wasmInstance;

  const wasmUrl = '/om-decoder.wasm';
  const response = await fetch(wasmUrl);
  const wasmBytes = await response.arrayBuffer();

  const { default: createModule } = await import('@openmeteo/file-format-wasm');
  const instance = await createModule({ wasmBinary: wasmBytes }) as OmWasm;
  wasmInstance = instance;

  return instance;
}

async function fetchRange(url: string, offset: number, size: number): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + size - 1}` }
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export interface OmReadResult {
  data: Float32Array;
  dims: number[];
}

export interface OmProgress {
  phase: string;
  loaded: number;
  total: number;
}

export async function readOmVariable(
  url: string,
  param: string,
  slices: number,
  onProgress?: (p: OmProgress) => void
): Promise<OmReadResult> {
  const wasm = await initOmWasm();

  // Phase 1: HEAD
  onProgress?.({ phase: 'head', loaded: 0, total: 1 });
  const headResp = await fetch(url, { method: 'HEAD' });
  if (!headResp.ok) throw new Error(`File not found: ${url}`);
  const fileSize = parseInt(headResp.headers.get('content-length')!, 10);

  // Phase 2: Trailer
  onProgress?.({ phase: 'trailer', loaded: 0, total: 1 });
  const trailerSize = wasm._om_trailer_size();
  const trailerData = await fetchRange(url, fileSize - trailerSize, trailerSize);

  const trailerPtr = wasm._malloc(trailerSize);
  const offsetPtr = wasm._malloc(8);
  const sizePtr = wasm._malloc(8);
  wasm.HEAPU8.set(trailerData, trailerPtr);

  if (!wasm._om_trailer_read(trailerPtr, offsetPtr, sizePtr)) {
    throw new Error('Failed to read trailer');
  }

  const rootOffset = Number(wasm.getValue(offsetPtr, 'i64'));
  const rootSize = Number(wasm.getValue(sizePtr, 'i64'));
  wasm._free(trailerPtr);
  wasm._free(offsetPtr);
  wasm._free(sizePtr);

  // Phase 3: Root + children metadata
  onProgress?.({ phase: 'metadata', loaded: 0, total: 1 });
  const rootData = await fetchRange(url, rootOffset, rootSize);

  const rootPtr = wasm._malloc(rootData.length);
  wasm.HEAPU8.set(rootData, rootPtr);
  const rootVar = wasm._om_variable_init(rootPtr);
  if (!rootVar) throw new Error('Failed to init root variable');

  const numChildren = wasm._om_variable_get_children_count(rootVar);

  // Find children range
  const o1Ptr = wasm._malloc(8);
  const s1Ptr = wasm._malloc(8);
  let childrenStart = Infinity, childrenEnd = 0;

  for (let i = 0; i < numChildren; i++) {
    wasm._om_variable_get_children(rootVar, i, 1, o1Ptr, s1Ptr);
    const off = Number(wasm.getValue(o1Ptr, 'i64'));
    const sz = Number(wasm.getValue(s1Ptr, 'i64'));
    if (off < childrenStart) childrenStart = off;
    if (off + sz > childrenEnd) childrenEnd = off + sz;
  }
  wasm._free(o1Ptr);
  wasm._free(s1Ptr);

  const allChildrenData = await fetchRange(url, childrenStart, childrenEnd - childrenStart);

  // Phase 4: Find param
  let targetVarOffset = 0, targetVarSize = 0, targetDims: number[] = [];
  const childOffsetPtr = wasm._malloc(8);
  const childSizePtr = wasm._malloc(8);
  const lengthPtr = wasm._malloc(2);
  const availableParams: string[] = [];

  for (let i = 0; i < numChildren; i++) {
    wasm._om_variable_get_children(rootVar, i, 1, childOffsetPtr, childSizePtr);
    const childOffset = Number(wasm.getValue(childOffsetPtr, 'i64'));
    const childSize = Number(wasm.getValue(childSizePtr, 'i64'));

    const localOffset = childOffset - childrenStart;
    const childData = allChildrenData.slice(localOffset, localOffset + childSize);

    const childPtr = wasm._malloc(childData.length);
    wasm.HEAPU8.set(childData, childPtr);
    const childVar = wasm._om_variable_init(childPtr);

    // _om_variable_get_name returns pointer, writes length to lengthPtr
    const namePtr = wasm._om_variable_get_name(childVar, lengthPtr);
    const nameLen = wasm.getValue(lengthPtr, 'i16') as number;
    if (nameLen > 0) {
      const nameBytes = wasm.HEAPU8.subarray(namePtr, namePtr + nameLen);
      const name = new TextDecoder().decode(nameBytes);
      availableParams.push(name);

      if (name === param) {
        targetVarOffset = childOffset;
        targetVarSize = childSize;
        const dimCount = Number(wasm._om_variable_get_dimensions_count(childVar));
        const dimsPtr = wasm._om_variable_get_dimensions(childVar);
        const int64View = new BigInt64Array(wasm.HEAPU8.buffer, dimsPtr, dimCount);
        targetDims = Array.from(int64View, v => Number(v));
      }
    }
    wasm._free(childPtr);
  }

  wasm._free(childOffsetPtr);
  wasm._free(childSizePtr);
  wasm._free(lengthPtr);
  wasm._free(rootPtr);

  if (!targetVarOffset) {
    console.log('[OM] Available params:', availableParams);
    throw new Error(`Parameter '${param}' not found. Available: ${availableParams.join(', ')}`);
  }

  console.log(`[OM] Found ${param}, dims=${JSON.stringify(targetDims)}, offset=${targetVarOffset}, size=${targetVarSize}`);

  // Phase 5: Discover data range via index
  const targetChildData = allChildrenData.slice(
    targetVarOffset - childrenStart,
    targetVarOffset - childrenStart + targetVarSize
  );

  const targetPtr = wasm._malloc(targetChildData.length);
  wasm.HEAPU8.set(targetChildData, targetPtr);
  const targetVar = wasm._om_variable_init(targetPtr);

  const nDims = targetDims.length;
  const readOffsetPtr = wasm._malloc(nDims * 8);
  const readCountPtr = wasm._malloc(nDims * 8);
  const cubeOffsetPtr = wasm._malloc(nDims * 8);
  const cubeDimPtr = wasm._malloc(nDims * 8);

  for (let i = 0; i < nDims; i++) {
    wasm.setValue(readOffsetPtr + i * 8, BigInt(0), 'i64');
    wasm.setValue(readCountPtr + i * 8, BigInt(targetDims[i]!), 'i64');
    wasm.setValue(cubeOffsetPtr + i * 8, BigInt(0), 'i64');
    wasm.setValue(cubeDimPtr + i * 8, BigInt(targetDims[i]!), 'i64');
  }

  const decoderPtr = wasm._malloc(SIZEOF_DECODER);
  const err = wasm._om_decoder_init(
    decoderPtr, targetVar, BigInt(nDims),
    readOffsetPtr, readCountPtr, cubeOffsetPtr, cubeDimPtr,
    BigInt(2048), BigInt(65536)
  );
  if (err !== ERROR_OK) throw new Error(`Decoder init failed: ${err}`);

  const indexReadPtr = wasm._malloc(64);
  wasm._om_decoder_init_index_read(decoderPtr, indexReadPtr);
  const errorPtr = wasm._malloc(4);
  wasm.setValue(errorPtr, ERROR_OK, 'i32');

  let minDataOffset = Infinity, maxDataEnd = 0;
  const indexBlocks: { offset: number; count: number; data: Uint8Array }[] = [];

  while (wasm._om_decoder_next_index_read(decoderPtr, indexReadPtr)) {
    const indexOffset = Number(wasm.getValue(indexReadPtr, 'i64'));
    const indexCount = Number(wasm.getValue(indexReadPtr + 8, 'i64'));

    const indexData = await fetchRange(url, indexOffset, indexCount);
    indexBlocks.push({ offset: indexOffset, count: indexCount, data: indexData });

    const indexDataPtr = wasm._malloc(indexData.length);
    wasm.HEAPU8.set(indexData, indexDataPtr);

    const dataReadPtr = wasm._malloc(64);
    wasm._om_decoder_init_data_read(dataReadPtr, indexReadPtr);

    while (wasm._om_decoder_next_data_read(decoderPtr, dataReadPtr, indexDataPtr, BigInt(indexCount), errorPtr)) {
      const dataOffset = Number(wasm.getValue(dataReadPtr, 'i64'));
      const dataCount = Number(wasm.getValue(dataReadPtr + 8, 'i64'));
      if (dataOffset < minDataOffset) minDataOffset = dataOffset;
      if (dataOffset + dataCount > maxDataEnd) maxDataEnd = dataOffset + dataCount;
    }

    wasm._free(indexDataPtr);
    wasm._free(dataReadPtr);
  }

  const totalCompressed = maxDataEnd - minDataOffset;

  // Phase 6: Fetch data slices
  const sliceBytes = Math.ceil(totalCompressed / slices);
  const allDataBuffer = new Uint8Array(totalCompressed);

  for (let i = 0; i < slices; i++) {
    onProgress?.({ phase: 'data', loaded: i, total: slices });
    const sliceStart = i * sliceBytes;
    const sliceEnd = Math.min(sliceStart + sliceBytes, totalCompressed);
    const data = await fetchRange(url, minDataOffset + sliceStart, sliceEnd - sliceStart);
    allDataBuffer.set(data, sliceStart);
  }

  // Phase 7: Decode
  onProgress?.({ phase: 'decode', loaded: 0, total: 1 });

  const outputElements = targetDims.reduce((a, b) => a * b, 1);
  const outputPtr = wasm._malloc(outputElements * 4);
  const chunkBufferSize = Number(wasm._om_decoder_read_buffer_size(decoderPtr));
  const chunkBufferPtr = wasm._malloc(chunkBufferSize);

  const decoder2Ptr = wasm._malloc(SIZEOF_DECODER);
  wasm._om_decoder_init(
    decoder2Ptr, targetVar, BigInt(nDims),
    readOffsetPtr, readCountPtr, cubeOffsetPtr, cubeDimPtr,
    BigInt(2048), BigInt(65536)
  );

  const indexRead2Ptr = wasm._malloc(64);
  wasm._om_decoder_init_index_read(decoder2Ptr, indexRead2Ptr);

  let blockIdx = 0;
  while (wasm._om_decoder_next_index_read(decoder2Ptr, indexRead2Ptr)) {
    const block = indexBlocks[blockIdx++]!;

    const indexDataPtr = wasm._malloc(block.data.length);
    wasm.HEAPU8.set(block.data, indexDataPtr);

    const dataRead2Ptr = wasm._malloc(64);
    wasm._om_decoder_init_data_read(dataRead2Ptr, indexRead2Ptr);

    while (wasm._om_decoder_next_data_read(decoder2Ptr, dataRead2Ptr, indexDataPtr, BigInt(block.count), errorPtr)) {
      const dataOffset = Number(wasm.getValue(dataRead2Ptr, 'i64'));
      const dataCount = Number(wasm.getValue(dataRead2Ptr + 8, 'i64'));
      const chunkIndexPtr = dataRead2Ptr + 32;

      const localOffset = dataOffset - minDataOffset;
      const chunkData = allDataBuffer.slice(localOffset, localOffset + dataCount);

      const dataBlockPtr = wasm._malloc(chunkData.length);
      wasm.HEAPU8.set(chunkData, dataBlockPtr);

      if (!wasm._om_decoder_decode_chunks(
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

  onProgress?.({ phase: 'done', loaded: 1, total: 1 });

  return { data: result, dims: targetDims };
}
