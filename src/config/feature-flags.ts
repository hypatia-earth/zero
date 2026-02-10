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
