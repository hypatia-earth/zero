/**
 * OmFileAdapter - Direct WASM access to Open-Meteo .om files
 *
 * Fetches .om files via HTTP range requests and decodes using WASM.
 * Supports streaming: fetch slice → decode complete chunks → yield → repeat
 */

import { fetchSuffix, fetchRange, type CacheLayer } from '../utils/fetch';
import { builtInLayers } from '../layers';
import type { TParam, TWeatherLayer } from '../config/types';

// Build param -> layer lookup from built-in layer declarations
const PARAM_TO_LAYER: Record<TParam, TWeatherLayer> = Object.fromEntries(
  builtInLayers.flatMap(layer =>
    layer.params?.map(param => [param, layer.id]) ?? []
  )
) as Record<TParam, TWeatherLayer>;

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
  _om_variable_get_dimensions(varPtr: number): number;
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

const DEBUG = false;

const SIZEOF_DECODER = 256;
const ERROR_OK = 0;

let wasmInstance: OmWasm | null = null;

/**
 * Initialize WASM module with pre-loaded binary
 * Binary is loaded by DataLoader during bootstrap
 */
export async function initOmWasm(wasmBinary: ArrayBuffer): Promise<OmWasm> {
  if (wasmInstance) return wasmInstance;

  const { default: createModule } = await import('./om-wasm-glue.js');
  const instance = await createModule({ wasmBinary }) as OmWasm;
  wasmInstance = instance;

  return instance;
}

/**
 * Check if WASM is initialized
 */
export function isOmWasmInitialized(): boolean {
  return wasmInstance !== null;
}

export interface OmReadResult {
  data: Float32Array;
  dims: number[];
  totalBytes?: number;  // Set in preflight-only mode
}

export interface OmChunkData {
  data: Float32Array;
  offset: number;
  count: number;
  sliceIndex: number;
  totalSlices: number;
  done: boolean;
}

export type OmChunkCallback = (chunk: OmChunkData) => void | Promise<void>;

/** Preflight info callback - called after metadata phases, before data fetch */
export type OmPreflightCallback = (info: { totalBytes: number; chunks: number }) => void;

interface ChunkInfo {
  dataOffset: number;
  dataCount: number;
  indexBlockIdx: number;
  indexData: Uint8Array;
  indexCount: number;
}

/** Map param name to cache layer */
function paramToLayer(param: string): CacheLayer {
  return PARAM_TO_LAYER[param as TParam] ?? 'meta';
}

export interface OmPreflightResult {
  totalBytes: number;
  chunks: number;
  dims: number[];
}

/**
 * Preflight-only: fetch metadata and return size info without data
 */
export async function preflightOmVariable(
  url: string,
  param: string
): Promise<OmPreflightResult> {
  const result = await streamOmVariable(url, param, 1, () => {}, undefined, true);
  return { totalBytes: result.totalBytes ?? 0, chunks: 0, dims: result.dims };
}

/** Byte progress callback - called after each slice fetch */
export type OmBytesCallback = (bytes: number) => void;

/**
 * Stream-read a variable from an .om file
 * Calls onChunk after each slice is fetched and its chunks decoded
 * Optional onPreflight called after metadata phases with exact byte size
 * Optional onBytes called after each data fetch with bytes received
 * Set preflightOnly=true to return after metadata without fetching data
 * Optional signal for abort cancellation
 */
export async function streamOmVariable(
  url: string,
  param: string,
  slices: number,
  onChunk: OmChunkCallback,
  onPreflight?: OmPreflightCallback,
  preflightOnly = false,
  onBytes?: OmBytesCallback,
  signal?: AbortSignal
): Promise<OmReadResult> {
  const cacheLayer = paramToLayer(param);
  if (!wasmInstance) {
    throw new Error('WASM not initialized. Call initOmWasm first.');
  }
  const wasm = wasmInstance;

  // Phase 1: Trailer via suffix range (bytes=-N gets last N bytes)
  const trailerSize = wasm._om_trailer_size();
  const trailerData = await fetchSuffix(url, trailerSize, 'meta');

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

  DEBUG && console.log(`[OM] Trailer: offset=${rootOffset}, size=${rootSize}`);

  // Phase 3: Root + children metadata
  const rootData = await fetchRange(url, rootOffset, rootSize, 'meta');

  const rootPtr = wasm._malloc(rootData.length);
  wasm.HEAPU8.set(rootData, rootPtr);
  DEBUG && console.log(`[OM] Root data first 16 bytes:`, Array.from(rootData.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '));
  const rootVar = wasm._om_variable_init(rootPtr);
  DEBUG && console.log(`[OM] rootVar pointer: ${rootVar}`);
  if (!rootVar) throw new Error('Failed to init root variable');

  const numChildren = wasm._om_variable_get_children_count(rootVar);

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

  const allChildrenData = await fetchRange(url, childrenStart, childrenEnd - childrenStart, 'meta');

  // Phase 4: Find param
  let targetVarOffset = 0, targetVarSize = 0, targetDims: number[] = [];
  const childOffsetPtr = wasm._malloc(8);
  const childSizePtr = wasm._malloc(8);
  const lengthPtr = wasm._malloc(2);
  const availableVars: string[] = [];

  // Check if root itself has the data (single-variable file)
  const rootNamePtr = wasm._om_variable_get_name(rootVar, lengthPtr);
  const rootNameLen = wasm.getValue(lengthPtr, 'i16') as number;
  const rootName = rootNameLen > 0
    ? new TextDecoder().decode(wasm.HEAPU8.subarray(rootNamePtr, rootNamePtr + rootNameLen))
    : '(no name)';

  const rootDimCount = Number(wasm._om_variable_get_dimensions_count(rootVar));
  DEBUG && console.log(`[OM] Root: '${rootName}', children: ${numChildren}, dims: ${rootDimCount}`);

  for (let i = 0; i < numChildren; i++) {
    wasm._om_variable_get_children(rootVar, i, 1, childOffsetPtr, childSizePtr);
    const childOffset = Number(wasm.getValue(childOffsetPtr, 'i64'));
    const childSize = Number(wasm.getValue(childSizePtr, 'i64'));

    const localOffset = childOffset - childrenStart;
    const childData = allChildrenData.slice(localOffset, localOffset + childSize);

    const childPtr = wasm._malloc(childData.length);
    wasm.HEAPU8.set(childData, childPtr);
    const childVar = wasm._om_variable_init(childPtr);

    const namePtr = wasm._om_variable_get_name(childVar, lengthPtr);
    const nameLen = wasm.getValue(lengthPtr, 'i16') as number;
    if (nameLen > 0) {
      const nameBytes = wasm.HEAPU8.subarray(namePtr, namePtr + nameLen);
      const name = new TextDecoder().decode(nameBytes);
      availableVars.push(name);

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
    throw new Error(`Parameter '${param}' not found. Available: ${availableVars.join(', ')}`);
  }

  // Phase 5: Discover all chunk ranges
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

  // Collect all chunk info and index blocks
  let minDataOffset = Infinity, maxDataEnd = 0;
  const indexBlocks: { offset: number; count: number; data: Uint8Array }[] = [];
  const allChunks: ChunkInfo[] = [];

  while (wasm._om_decoder_next_index_read(decoderPtr, indexReadPtr)) {
    const indexOffset = Number(wasm.getValue(indexReadPtr, 'i64'));
    const indexCount = Number(wasm.getValue(indexReadPtr + 8, 'i64'));

    const indexData = await fetchRange(url, indexOffset, indexCount, cacheLayer);
    const blockIdx = indexBlocks.length;
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

      allChunks.push({
        dataOffset,
        dataCount,
        indexBlockIdx: blockIdx,
        indexData,
        indexCount
      });
    }

    wasm._free(indexDataPtr);
    wasm._free(dataReadPtr);
  }

  const totalCompressed = maxDataEnd - minDataOffset;
  const numChunks = allChunks.length;
  const outputElements = targetDims.reduce((a, b) => a * b, 1);

  // Report preflight info (exact bytes known before data fetch)
  onPreflight?.({ totalBytes: totalCompressed, chunks: numChunks });

  // Early return for preflight-only mode
  if (preflightOnly) {
    wasm._free(decoderPtr);
    wasm._free(indexReadPtr);
    wasm._free(errorPtr);
    wasm._free(readOffsetPtr);
    wasm._free(readCountPtr);
    wasm._free(cubeOffsetPtr);
    wasm._free(cubeDimPtr);
    wasm._free(targetPtr);
    return { data: new Float32Array(0), dims: targetDims, totalBytes: totalCompressed };
  }

  // Calculate chunk-aligned slices: first slice gets remainder, rest get equal chunks
  const chunksPerSlice = Math.floor(numChunks / slices);
  const firstSliceChunks = numChunks - chunksPerSlice * (slices - 1);

  DEBUG && console.log(`[OM] ${numChunks} chunks, ${(totalCompressed / 1024).toFixed(0)} KB, slices: first=${firstSliceChunks}, rest=${chunksPerSlice}`);
  const sliceStartTime = performance.now();

  // Allocate output and decode buffer
  const outputPtr = wasm._malloc(outputElements * 4);
  const chunkBufferSize = Number(wasm._om_decoder_read_buffer_size(decoderPtr));
  const chunkBufferPtr = wasm._malloc(chunkBufferSize);

  // Track fetched data
  const allDataBuffer = new Uint8Array(totalCompressed);
  let nextChunkIdx = 0;

  // Phase 6+7: Fetch chunk-aligned slices and decode
  for (let sliceIdx = 0; sliceIdx < slices; sliceIdx++) {
    // Determine which chunks belong to this slice
    const sliceChunkCount = sliceIdx === 0 ? firstSliceChunks : chunksPerSlice;
    const sliceStartChunk = nextChunkIdx;
    const sliceEndChunk = sliceStartChunk + sliceChunkCount;

    // Calculate byte range for these chunks
    const firstChunk = allChunks[sliceStartChunk]!;
    const lastChunk = allChunks[sliceEndChunk - 1]!;
    const sliceByteStart = firstChunk.dataOffset - minDataOffset;
    const sliceByteEnd = (lastChunk.dataOffset - minDataOffset) + lastChunk.dataCount;
    const sliceSize = sliceByteEnd - sliceByteStart;

    // Check abort at slice boundary (before fetch, after previous slice cleanup)
    if (signal?.aborted) {
      wasm._free(outputPtr);
      wasm._free(chunkBufferPtr);
      wasm._free(decoderPtr);
      wasm._free(indexReadPtr);
      wasm._free(errorPtr);
      wasm._free(readOffsetPtr);
      wasm._free(readCountPtr);
      wasm._free(cubeOffsetPtr);
      wasm._free(cubeDimPtr);
      wasm._free(targetPtr);
      throw new DOMException('Aborted', 'AbortError');
    }

    // Fetch this slice (use layer for caching)
    const sliceData = await fetchRange(url, firstChunk.dataOffset, sliceSize, cacheLayer);
    allDataBuffer.set(sliceData, sliceByteStart);
    onBytes?.(sliceData.length);

    // Decode all chunks in this slice (guaranteed complete since chunk-aligned)
    while (nextChunkIdx < sliceEndChunk) {
      const chunk = allChunks[nextChunkIdx]!;

      // Decode this chunk
      const decoder2Ptr = wasm._malloc(SIZEOF_DECODER);
      wasm._om_decoder_init(
        decoder2Ptr, targetVar, BigInt(nDims),
        readOffsetPtr, readCountPtr, cubeOffsetPtr, cubeDimPtr,
        BigInt(2048), BigInt(65536)
      );

      // Skip to the right index block and chunk
      const indexRead2Ptr = wasm._malloc(64);
      wasm._om_decoder_init_index_read(decoder2Ptr, indexRead2Ptr);

      let foundChunk = false;
      let currentBlockIdx = 0;
      while (wasm._om_decoder_next_index_read(decoder2Ptr, indexRead2Ptr)) {
        if (currentBlockIdx === chunk.indexBlockIdx) {
          const indexDataPtr = wasm._malloc(chunk.indexData.length);
          wasm.HEAPU8.set(chunk.indexData, indexDataPtr);

          const dataRead2Ptr = wasm._malloc(64);
          wasm._om_decoder_init_data_read(dataRead2Ptr, indexRead2Ptr);

          while (wasm._om_decoder_next_data_read(decoder2Ptr, dataRead2Ptr, indexDataPtr, BigInt(chunk.indexCount), errorPtr)) {
            const thisOffset = Number(wasm.getValue(dataRead2Ptr, 'i64'));
            const thisCount = Number(wasm.getValue(dataRead2Ptr + 8, 'i64'));

            if (thisOffset === chunk.dataOffset && thisCount === chunk.dataCount) {
              const chunkIndexPtr = dataRead2Ptr + 32;
              const localOffset = chunk.dataOffset - minDataOffset;
              const chunkData = allDataBuffer.slice(localOffset, localOffset + chunk.dataCount);

              const dataBlockPtr = wasm._malloc(chunkData.length);
              wasm.HEAPU8.set(chunkData, dataBlockPtr);

              if (!wasm._om_decoder_decode_chunks(
                decoder2Ptr, chunkIndexPtr, dataBlockPtr, BigInt(chunk.dataCount),
                outputPtr, chunkBufferPtr, errorPtr
              )) {
                throw new Error(`Decode failed: ${wasm.getValue(errorPtr, 'i32')}`);
              }

              wasm._free(dataBlockPtr);
              foundChunk = true;
              break;
            }
          }

          wasm._free(dataRead2Ptr);
          wasm._free(indexDataPtr);
        }
        currentBlockIdx++;
        if (foundChunk) break;
      }

      wasm._free(indexRead2Ptr);
      wasm._free(decoder2Ptr);

      nextChunkIdx++;
    }

    // Yield current state after each slice
    const currentData = new Float32Array(outputElements);
    currentData.set(new Float32Array(wasm.HEAPU8.buffer, outputPtr, outputElements));

    await onChunk({
      data: currentData,
      offset: 0,
      count: outputElements,
      sliceIndex: sliceIdx,
      totalSlices: slices,
      done: sliceIdx === slices - 1
    });
  }

  const sliceElapsed = ((performance.now() - sliceStartTime) / 1000).toFixed(1);
  DEBUG && console.log(`[OM] ${slices} slices loaded in ${sliceElapsed}s`);

  const result = new Float32Array(outputElements);
  result.set(new Float32Array(wasm.HEAPU8.buffer, outputPtr, outputElements));

  // Cleanup
  wasm._free(outputPtr);
  wasm._free(chunkBufferPtr);
  wasm._free(decoderPtr);
  wasm._free(indexReadPtr);
  wasm._free(errorPtr);
  wasm._free(readOffsetPtr);
  wasm._free(readCountPtr);
  wasm._free(cubeOffsetPtr);
  wasm._free(cubeDimPtr);
  wasm._free(targetPtr);

  return { data: result, dims: targetDims };
}
