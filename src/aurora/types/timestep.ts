/**
 * Branded timestep string, format: "YYYY-MM-DDTHHMM" (e.g., "2025-12-13T0600").
 *
 * Lives in aurora/types/ for autarky; the host re-exports from `config/types`
 * for any host-side use.
 */
export type TTimestep = string & { readonly __brand: 'timestep' };
