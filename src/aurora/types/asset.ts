/**
 * Asset manifest — aurora declares; host fetches and decodes; init receives the bag.
 *
 * Two sources flow into the manifest:
 *   - Engine primitives (gaussian-grid LUTs, OM decoder WASM, atmosphere LUTs).
 *     `layerId` is undefined for these.
 *   - Layer-declared assets — built-ins embed their lists alongside layer code;
 *     app-side layers declare via `AuroraLayerSpec.requiredAssets`.
 */

export interface AssetSpec {
  /** Unique within the manifest, e.g., 'graticule.fontAtlas'. */
  key: string;
  /** Relative to host-provided baseUrl. */
  url: string;
  format: 'binary' | 'image' | 'json' | 'text';
  /** Hint for progress UI smoothness (bytes). */
  estimatedSize?: number;
  /** Omitted for aurora engine assets. */
  layerId?: string;
}

/** Decoded payloads keyed by AssetSpec.key. */
export type AssetBag = Map<string, ArrayBuffer | ImageBitmap | unknown>;
