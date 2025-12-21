/**
 * Decompress Worker - WASM decoder in Web Worker
 *
 * Runs streamOmVariable in worker thread for parallel decompression.
 * Each worker has its own WASM instance.
 */

import { initOmWasm, streamOmVariable } from '../adapters/om-file-adapter';

let ready = false;

export interface WorkerRequest {
  type: 'init' | 'fetch';
  id?: string;
  wasmBinary?: ArrayBuffer;
  url?: string;
  param?: string;
  slices?: number;
}

export interface WorkerResponse {
  type: 'ready' | 'preflight' | 'slice' | 'bytes' | 'done' | 'error';
  id?: string;
  data?: Float32Array;
  totalBytes?: number;
  chunks?: number;
  sliceIndex?: number;
  totalSlices?: number;
  isDone?: boolean;
  bytes?: number;
  error?: string;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { type, id, wasmBinary, url, param, slices = 10 } = e.data;

  if (type === 'init') {
    try {
      await initOmWasm(wasmBinary!);
      ready = true;
      self.postMessage({ type: 'ready' } as WorkerResponse);
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err) } as WorkerResponse);
    }
    return;
  }

  if (type === 'fetch') {
    if (!ready) {
      self.postMessage({ type: 'error', id, error: 'Worker not initialized' } as WorkerResponse);
      return;
    }

    try {
      const result = await streamOmVariable(
        url!,
        param!,
        slices,
        // onChunk callback
        (chunk) => {
          // Transfer Float32Array back to main thread
          const transferable = chunk.data.buffer as ArrayBuffer;
          (self as unknown as Worker).postMessage(
            {
              type: 'slice',
              id,
              data: chunk.data,
              sliceIndex: chunk.sliceIndex,
              totalSlices: chunk.totalSlices,
              isDone: chunk.done,
            } as WorkerResponse,
            [transferable]
          );
        },
        // onPreflight callback
        (info) => {
          self.postMessage({
            type: 'preflight',
            id,
            totalBytes: info.totalBytes,
            chunks: info.chunks,
          } as WorkerResponse);
        },
        false, // preflightOnly
        // onBytes callback
        (bytes) => {
          self.postMessage({
            type: 'bytes',
            id,
            bytes,
          } as WorkerResponse);
        }
      );

      // Send final result (transfer the buffer)
      const transferable = result.data.buffer as ArrayBuffer;
      (self as unknown as Worker).postMessage(
        {
          type: 'done',
          id,
          data: result.data,
        } as WorkerResponse,
        [transferable]
      );
    } catch (err) {
      self.postMessage({
        type: 'error',
        id,
        error: err instanceof Error ? err.message : String(err),
      } as WorkerResponse);
    }
  }
};
