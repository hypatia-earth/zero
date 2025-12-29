/**
 * Viewport Controls Module
 *
 * Re-exports all viewport control components
 */

export { GestureDetector } from './gesture-detector';
export type { GestureDirection, TwoFingerGestureMode, GestureDetectorConfig } from './gesture-detector';

export { PhysicsModel } from './physics-model';
export type { InertiaConfig, VelocityConfig, ZoomConfig, PhysicsState, PhysicsUpdateResult } from './physics-model';

export { MouseInputHandler } from './mouse-input-handler';
export type {
  MouseDragConfig,
  MouseWheelZoomConfig,
  MouseWheelTimeConfig,
  MouseDoubleClickConfig,
  MouseInputCallbacks,
} from './mouse-input-handler';

export { TouchInputHandler } from './touch-input-handler';
export type {
  TouchDragConfig,
  TouchPinchConfig,
  TouchPanConfig,
  TouchTapConfig,
  TouchInputCallbacks,
} from './touch-input-handler';
