/**
 * Aurora event channel — host registers a single `onEvent` callback at init.
 *
 * Discriminated by `type`. New event kinds extend the union; consumers narrow
 * on `type` for type-safe handling.
 */

export type AuroraEvent =
  | { type: 'firstFrameRendered' }
  | { type: 'layerDataReady'; id: string }
  | { type: 'layerDataUnready'; id: string }
  | { type: 'deviceLost' }
  | { type: 'error'; category: string; detail: string }
  | { type: 'captureProgress'; k: number; n: number };
