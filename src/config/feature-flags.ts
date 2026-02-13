/**
 * Feature flags for gradual migration to declarative layer system
 */

/**
 * When true:
 * - Layers are loaded from LayerRegistry instead of hardcoded
 * - Uses aurora-v2.worker.ts with ShaderComposer
 * - Supports user-defined layers
 *
 * Set to true only after V2 passes all E2E tests.
 */
export const USE_DECLARATIVE_LAYERS = true;

/**
 * When true:
 * - Uses ParamSlotService (param-centric) instead of SlotService (layer-centric)
 * - GPU slots keyed by param name (e.g., 'temperature_2m') not layer (e.g., 'temp')
 * - Multiple layers can share same param data
 * - User layers can get data independently of built-in layers
 *
 * Migration path: test with flag true, then delete SlotService and rename.
 */
export const USE_PARAM_SLOTS = false;
