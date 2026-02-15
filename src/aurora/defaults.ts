/**
 * Aurora engine defaults
 *
 * Engine-specific defaults, separate from app config.
 */

import type { CameraConfig } from './camera';

export const CAMERA_DEFAULTS: CameraConfig = {
  fov: 75,
  near: 0.1,
  far: 100,
};
