/**
 * GPU buffer slab definition for weather layers.
 *
 * Lives in aurora/types/ for autarky; the host re-exports from `config/types`
 * for any host-side use.
 */
export interface SlabConfig {
  name: string;   // e.g., 'data', 'u', 'v', 'raw', 'grid'
  sizeMB: number; // Size in megabytes
}
