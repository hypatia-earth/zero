/**
 * Ring buffer utility for averaging frame times
 */

export interface RingBuffer {
  push: (item: number) => void;
  buf: number[];
  get: (key: number) => number | undefined;
  last: () => number | undefined;
  max: () => number;
  min: () => number;
  sum: () => number;
  avg: () => number;
}

export function createRingBuffer(length: number): RingBuffer {
  let pointer = 0;
  let lastPointer = 0;
  const buffer: number[] = [];

  return {
    push: (item: number) => {
      buffer[pointer] = item;
      lastPointer = pointer;
      pointer = (length + pointer + 1) % length;
    },
    buf: buffer,
    get: (key: number) => buffer[key],
    last: () => buffer[lastPointer],
    max: () => Math.max(...buffer),
    min: () => Math.min(...buffer),
    sum: () => buffer.reduce((a, b) => a + b, 0),
    avg: () => buffer.reduce((a, b) => a + b, 0) / buffer.length,
  };
}
