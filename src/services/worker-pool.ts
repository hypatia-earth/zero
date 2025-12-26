/**
 * WorkerPool - Manages pool of WASM decoder workers
 *
 * Dispatches decode jobs to idle workers, queues when busy.
 * Each worker has its own WASM instance for true parallelism.
 */

import type { WorkerRequest, WorkerResponse } from '../workers/decompress.worker';
import type { OmSlice, OmPreflight } from '../config/types';

const DEBUG = false;

interface PendingJob {
  url: string;
  param: string;
  slices: number;
  onPreflight: (info: OmPreflight) => void;
  onSlice: (slice: OmSlice) => void;
  onBytes: ((bytes: number) => void) | undefined;
  signal: AbortSignal | undefined;
  resolve: (data: Float32Array) => void;
  reject: (err: Error) => void;
}

interface ActiveJob extends PendingJob {
  id: string;
  worker: Worker;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private active = new Map<string, ActiveJob>();
  private queue: PendingJob[] = [];
  private jobId = 0;
  private initialized = false;

  constructor(
    private poolSize: number,
    private wasmBinary: ArrayBuffer
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(
        new URL('../workers/decompress.worker.ts', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        this.handleMessage(worker, e.data);
      };

      worker.onerror = (e) => {
        console.error(`[WorkerPool] Worker error:`, e);
        // Remove failed worker and spawn replacement
        this.replaceWorker(worker);
      };

      this.workers.push(worker);

      // Initialize WASM in worker
      initPromises.push(new Promise<void>((resolve, reject) => {
        const handler = (e: MessageEvent<WorkerResponse>) => {
          if (e.data.type === 'ready') {
            worker.removeEventListener('message', handler);
            this.idle.push(worker);
            resolve();
          } else if (e.data.type === 'error') {
            worker.removeEventListener('message', handler);
            reject(new Error(e.data.error));
          }
        };
        worker.addEventListener('message', handler);
        worker.postMessage({ type: 'init', wasmBinary: this.wasmBinary } as WorkerRequest);
      }));
    }

    await Promise.all(initPromises);
    this.initialized = true;
    console.log(`[WorkerPool] ${this.poolSize} workers ready`);
  }

  /**
   * Fetch and decode an .om file
   * Same interface as OmService.fetch() for drop-in replacement
   */
  fetch(
    url: string,
    param: string,
    onPreflight: (info: OmPreflight) => void,
    onSlice: (slice: OmSlice) => void,
    onBytes?: (bytes: number) => void,
    signal?: AbortSignal
  ): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      // Check if already aborted
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      const job: PendingJob = {
        url,
        param,
        slices: 10,
        onPreflight,
        onSlice,
        onBytes,
        signal,
        resolve,
        reject,
      };

      const idleWorker = this.idle.pop();
      if (idleWorker) {
        this.dispatch(idleWorker, job);
      } else {
        // All workers busy, queue for later
        this.queue.push(job);
      }
    });
  }

  private dispatch(worker: Worker, job: PendingJob): void {
    const id = String(this.jobId++);
    const activeJob: ActiveJob = { ...job, id, worker };
    this.active.set(id, activeJob);

    // Listen for abort signal
    if (job.signal) {
      const onAbort = () => {
        worker.postMessage({ type: 'abort', id } as WorkerRequest);
        // Clean up - job will be removed when worker responds (or silently if already done)
        this.active.delete(id);
        job.reject(new DOMException('Aborted', 'AbortError'));
        this.processQueue(worker);
      };
      job.signal.addEventListener('abort', onAbort, { once: true });
    }

    worker.postMessage({
      type: 'fetch',
      id,
      url: job.url,
      param: job.param,
      slices: job.slices,
    } as WorkerRequest);
  }

  private handleMessage(worker: Worker, msg: WorkerResponse): void {
    const { type, id } = msg;

    // Skip 'ready' messages (handled during init)
    if (type === 'ready') return;

    const job = id ? this.active.get(id) : undefined;
    if (!job) {
      DEBUG && console.warn(`[WorkerPool] Message for unknown job: ${id}`);
      return;
    }

    switch (type) {
      case 'preflight':
        job.onPreflight({ totalBytes: msg.totalBytes!, chunks: msg.chunks! });
        break;

      case 'slice':
        job.onSlice({
          data: msg.data!,
          sliceIndex: msg.sliceIndex!,
          totalSlices: msg.totalSlices!,
          done: msg.isDone!,
        });
        break;

      case 'bytes':
        job.onBytes?.(msg.bytes!);
        break;

      case 'done':
        this.active.delete(id!);
        job.resolve(msg.data!);
        this.processQueue(worker);
        break;

      case 'error':
        this.active.delete(id!);
        job.reject(new Error(msg.error ?? 'Unknown error'));
        this.processQueue(worker);
        break;
    }
  }

  private processQueue(worker: Worker): void {
    // Skip aborted jobs in queue
    let front = this.queue[0];
    while (front && front.signal?.aborted) {
      this.queue.shift();
      front.reject(new DOMException('Aborted', 'AbortError'));
      front = this.queue[0];
    }

    const next = this.queue.shift();
    if (next) {
      this.dispatch(worker, next);
    } else {
      this.idle.push(worker);
    }
  }

  private replaceWorker(failedWorker: Worker): void {
    // Remove from all lists
    this.workers = this.workers.filter(w => w !== failedWorker);
    this.idle = this.idle.filter(w => w !== failedWorker);

    // Reject any active job on this worker
    for (const [id, job] of this.active) {
      if (job.worker === failedWorker) {
        this.active.delete(id);
        job.reject(new Error('Worker crashed'));
      }
    }

    // Spawn replacement
    const worker = new Worker(
      new URL('../workers/decompress.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      this.handleMessage(worker, e.data);
    };

    worker.onerror = (e) => {
      console.error(`[WorkerPool] Replacement worker error:`, e);
      this.replaceWorker(worker);
    };

    this.workers.push(worker);

    // Initialize and add to idle
    const handler = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.type === 'ready') {
        worker.removeEventListener('message', handler);
        this.processQueue(worker);
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ type: 'init', wasmBinary: this.wasmBinary } as WorkerRequest);
  }

  dispose(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.idle = [];
    this.active.clear();
    this.queue = [];
    this.initialized = false;
  }
}
