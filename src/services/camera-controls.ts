/**
 * Camera Controls - Mouse/touch interaction for globe navigation
 *
 * Uses modular input handlers and physics model from viewport-controls.
 */

import type { Camera } from '../render/camera';
import type { StateService } from './state-service';
import type { ConfigService } from './config-service';
import type { OptionsService } from './options-service';
import { EARTH_RADIUS } from '../config/defaults';
import {
  GestureDetector,
  PhysicsModel,
  MouseInputHandler,
  TouchInputHandler,
} from './viewport-controls';

const EARTH_RADIUS_KM = EARTH_RADIUS / 1000;  // 6371 km

// Minutes per pixel for time scrolling
const TIME_MINUTES_PER_PIXEL = 0.5;

export function setupCameraControls(
  canvas: HTMLCanvasElement,
  camera: Camera,
  stateService: StateService,
  configService: ConfigService,
  optionsService: OptionsService
): void {
  const cameraConfig = configService.getCameraConfig();
  const minDistance = cameraConfig.minDistance;
  const maxDistance = cameraConfig.maxDistance;

  // Initialize from state
  const viewState = stateService.viewState.value;
  camera.setPosition(viewState.lat, viewState.lon, (viewState.altitude + EARTH_RADIUS_KM) / EARTH_RADIUS_KM);

  // Create physics model
  const physics = new PhysicsModel(-89, 89);
  physics.initFromCamera(camera.lat, camera.lon, camera.distance);

  // Create gesture detector
  const gestureDetector = new GestureDetector({
    idleResetMs: 150,
    twoFingerThreshold: 10,
  });

  // Track dragging state
  let isDragging = false;

  // Helper to check if point is on globe (simplified - always true for now)
  const isPointOnGlobe = (_clientX: number, _clientY: number): boolean => {
    // TODO: implement ray-sphere intersection check
    return true;
  };

  // Get current options
  const getOptions = () => optionsService.options.value.viewport;

  // Mouse input handler
  const mouseHandler = new MouseInputHandler({
    onDragStart: () => {
      isDragging = true;
      physics.stopVelocities();
      canvas.style.cursor = 'grabbing';
    },

    onDragMove: (pixelVelocityX: number, pixelVelocityY: number) => {
      const opts = getOptions();
      const sensitivity = opts.mouse.drag.sensitivity;
      const invert = opts.mouse.drag.invert ? -1 : 1;

      // Convert pixel velocity to angular velocity
      // Note: positive pixelVelocityY (drag down) should decrease lat (move camera south to see north)
      // Sign flip: Hypatia uses phi which increases south, we use lat which increases north
      const lonDelta = -pixelVelocityX * sensitivity * invert;
      const latDelta = pixelVelocityY * sensitivity * invert;

      if (opts.physicsModel === 'inertia') {
        physics.lonForce = lonDelta * 1000;
        physics.latForce = latDelta * 1000;
      } else {
        physics.lonVelocity = lonDelta;
        physics.latVelocity = latDelta;
      }
    },

    onDragEnd: () => {
      isDragging = false;
      canvas.style.cursor = 'grab';
    },

    onWheelZoom: (deltaY: number) => {
      const opts = getOptions();
      const speed = opts.mouse.wheel.zoom.speed;
      const invert = opts.mouse.wheel.zoom.invert ? -1 : 1;

      const zoomFactor = 1 + deltaY * 0.001 * speed * invert;
      physics.targetDistance = Math.max(minDistance, Math.min(maxDistance, physics.targetDistance * zoomFactor));
    },

    onWheelTime: (deltaX: number) => {
      const opts = getOptions();
      const invert = opts.mouse.wheel.time.invert ? -1 : 1;

      const minutesDelta = deltaX * TIME_MINUTES_PER_PIXEL * invert;
      const currentTime = stateService.viewState.value.time;
      const newTime = new Date(currentTime.getTime() + minutesDelta * 60 * 1000);
      stateService.setTime(newTime);
    },

    onDoubleClick: () => {
      // Zoom in on double-click
      physics.targetDistance = Math.max(minDistance, physics.targetDistance * 0.7);
    },

    onClick: () => {
      // Could be used for location selection
    },

    detectWheelGesture: (deltaX, deltaY) => gestureDetector.detectWheelGesture(deltaX, deltaY),

    isPointOnGlobe,
  });

  // Touch input handler
  const touchHandler = new TouchInputHandler(
    {
      onDragStart: () => {
        isDragging = true;
        physics.stopVelocities();
      },

      onDragMove: (pixelVelocityX: number, pixelVelocityY: number) => {
        const opts = getOptions();
        const sensitivity = opts.touch.oneFingerDrag.sensitivity;
        const invert = opts.touch.oneFingerDrag.invert ? -1 : 1;

        const lonDelta = -pixelVelocityX * sensitivity * invert;
        const latDelta = pixelVelocityY * sensitivity * invert;

        if (opts.physicsModel === 'inertia') {
          physics.lonForce = lonDelta * 1000;
          physics.latForce = latDelta * 1000;
        } else {
          physics.lonVelocity = lonDelta;
          physics.latVelocity = latDelta;
        }
      },

      onDragEnd: () => {
        isDragging = false;
      },

      onPinchZoom: (distanceDelta: number) => {
        const opts = getOptions();
        const speed = opts.touch.twoFingerPinch.speed;
        const invert = opts.touch.twoFingerPinch.invert ? -1 : 1;

        const zoomFactor = 1 - distanceDelta * 0.005 * speed * invert;
        physics.targetDistance = Math.max(minDistance, Math.min(maxDistance, physics.targetDistance * zoomFactor));
      },

      onPanTime: (deltaX: number) => {
        const opts = getOptions();
        const invert = opts.touch.twoFingerPan.invert ? -1 : 1;

        const minutesDelta = deltaX * TIME_MINUTES_PER_PIXEL * invert;
        const currentTime = stateService.viewState.value.time;
        const newTime = new Date(currentTime.getTime() + minutesDelta * 60 * 1000);
        stateService.setTime(newTime);
      },

      onTap: () => {
        // Tap to zoom
        physics.targetDistance = Math.max(minDistance, physics.targetDistance * 0.7);
      },

      detectTwoFingerGesture: (distanceDelta, panDeltaX, panDeltaY) =>
        gestureDetector.detectTwoFingerGesture(distanceDelta, panDeltaX, panDeltaY),

      getTwoFingerMode: () => gestureDetector.getTwoFingerMode(),

      resetTwoFingerGestureAfterIdle: () => gestureDetector.resetTwoFingerGestureAfterIdle(),

      resetTwoFingerGesture: () => gestureDetector.resetTwoFingerGesture(),
    },
    {
      maxDurationMs: 200,
      maxDistancePx: 10,
      zoomFactor: 0.7,
      animationMs: 300,
    }
  );

  // Attach event listeners
  canvas.addEventListener('mousedown', (e) => mouseHandler.handleMouseDown(e));
  window.addEventListener('mousemove', (e) => mouseHandler.handleMouseMove(e));
  window.addEventListener('mouseup', (e) => mouseHandler.handleMouseUp(e));
  canvas.addEventListener('wheel', (e) => mouseHandler.handleWheel(e), { passive: false });
  canvas.addEventListener('click', (e) => mouseHandler.handleClick(e));
  canvas.addEventListener('dblclick', (e) => mouseHandler.handleDoubleClick(e));

  canvas.addEventListener('touchstart', (e) => touchHandler.handleTouchStart(e));
  canvas.addEventListener('touchmove', (e) => touchHandler.handleTouchMove(e), { passive: false });
  canvas.addEventListener('touchend', (e) => {
    const opts = getOptions();
    touchHandler.handleTouchEnd(e, opts.tapToZoom);
  });

  // Animation loop
  let lastTime = performance.now();

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const deltaTime = (now - lastTime) / 1000;
    lastTime = now;

    // Skip if delta is too large (tab was inactive)
    if (deltaTime > 0.1) return;

    const opts = getOptions();

    // Update physics based on model
    if (opts.physicsModel === 'inertia') {
      physics.updateInertia(deltaTime, {
        mass: opts.mass,
        friction: 0.15,  // Fixed friction for inertia model
        fingerFriction: 0.8,
      }, isDragging);
    } else {
      physics.updateVelocity({
        baseFriction: opts.friction,
        maxFriction: 0.99,
        frictionScale: 0.1,
        minVelocity: 0.01,
        maxVelocity: 1000,
      });
    }

    // Apply velocity to position
    physics.applyVelocity(deltaTime);

    // Apply zoom damping
    physics.applyZoomDamping(0.1);

    // Apply time momentum
    const hoursDelta = physics.applyTimeMomentum(deltaTime);
    if (hoursDelta !== 0) {
      const currentTime = stateService.viewState.value.time;
      const newTime = new Date(currentTime.getTime() + hoursDelta * 60 * 60 * 1000);
      stateService.setTime(newTime);
    }

    // Update camera from physics
    camera.lat = physics.lat;
    camera.lon = physics.lon;
    camera.distance = physics.distance;

    // Sync to state
    updateState();
  }

  animate();

  // Initial cursor
  canvas.style.cursor = 'grab';

  function updateState() {
    const altitude = (camera.distance - 1) * EARTH_RADIUS_KM;
    stateService.setPosition(camera.lat, camera.lon, altitude);
  }
}
