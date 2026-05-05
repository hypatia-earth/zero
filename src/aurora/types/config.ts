/**
 * Aurora init-only configuration.
 *
 * AuroraConfig is set at init() and never changes at runtime. Distinct from
 * AuroraOptions, which is mutable and persisted in aurora-db.
 *
 * The host injects build-time constants here (camera frustum, future flags).
 */

export interface AuroraConfig {
  camera: {
    near: number;
    far: number;
    fov: number;                // degrees
  };
}
