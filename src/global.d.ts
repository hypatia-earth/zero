/**
 * Global type augmentations for external APIs
 *
 * Eliminates double-casts and repetitive narrowing at API boundaries.
 */

// ─── WebGPU: legacy GPUAdapter.adapterInfo (Chrome/Safari) ───────────────────
interface GPUAdapter {
  readonly adapterInfo?: GPUAdapterInfo;
}
