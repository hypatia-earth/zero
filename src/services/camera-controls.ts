/**
 * Camera Controls - Mouse/touch interaction for globe navigation
 */

import type { Camera } from '../render/camera';
import type { OptionsService } from './options-service';
import type { ConfigService } from './config-service';
import { EARTH_RADIUS } from '../config/defaults';

const EARTH_RADIUS_KM = EARTH_RADIUS / 1000;  // 6371 km

interface DragState {
  active: boolean;
  lastX: number;
  lastY: number;
  velocityLat: number;
  velocityLon: number;
}

export function setupCameraControls(
  canvas: HTMLCanvasElement,
  camera: Camera,
  optionsService: OptionsService,
  configService: ConfigService
): void {
  const drag: DragState = {
    active: false,
    lastX: 0,
    lastY: 0,
    velocityLat: 0,
    velocityLon: 0,
  };

  const cameraConfig = configService.getCameraConfig();
  const sensitivity = 0.3;
  const friction = 0.92;
  const minDistance = cameraConfig.minDistance;
  const maxDistance = cameraConfig.maxDistance;

  // Sync camera from options state
  const viewState = optionsService.options.value.viewState;
  camera.setPosition(viewState.lat, viewState.lon, (viewState.altitude + EARTH_RADIUS_KM) / EARTH_RADIUS_KM);

  // Mouse events
  canvas.addEventListener('mousedown', (e) => {
    drag.active = true;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    drag.velocityLat = 0;
    drag.velocityLon = 0;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag.active) return;

    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;

    drag.velocityLon = -dx * sensitivity;
    drag.velocityLat = dy * sensitivity;

    camera.lon += drag.velocityLon;
    camera.lat += drag.velocityLat;
    camera.lat = Math.max(-89, Math.min(89, camera.lat));

    drag.lastX = e.clientX;
    drag.lastY = e.clientY;

    updateState();
  });

  window.addEventListener('mouseup', () => {
    if (drag.active) {
      drag.active = false;
      canvas.style.cursor = 'grab';
    }
  });

  // Wheel zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomSpeed = 0.001;
    camera.distance *= 1 + e.deltaY * zoomSpeed;
    camera.distance = Math.max(minDistance, Math.min(maxDistance, camera.distance));
    updateState();
  }, { passive: false });

  // Touch events
  let touchStartDistance = 0;
  let touchStartCameraDistance = camera.distance;

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      drag.active = true;
      drag.lastX = e.touches[0]!.clientX;
      drag.lastY = e.touches[0]!.clientY;
      drag.velocityLat = 0;
      drag.velocityLon = 0;
    } else if (e.touches.length === 2) {
      drag.active = false;
      const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
      const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
      touchStartDistance = Math.sqrt(dx * dx + dy * dy);
      touchStartCameraDistance = camera.distance;
    }
  });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();

    if (e.touches.length === 1 && drag.active) {
      const touch = e.touches[0]!;
      const dx = touch.clientX - drag.lastX;
      const dy = touch.clientY - drag.lastY;

      drag.velocityLon = -dx * sensitivity;
      drag.velocityLat = dy * sensitivity;

      camera.lon += drag.velocityLon;
      camera.lat += drag.velocityLat;
      camera.lat = Math.max(-89, Math.min(89, camera.lat));

      drag.lastX = touch.clientX;
      drag.lastY = touch.clientY;
      updateState();
    } else if (e.touches.length === 2) {
      const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
      const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const scale = touchStartDistance / distance;
      camera.distance = Math.max(minDistance, Math.min(maxDistance, touchStartCameraDistance * scale));
      updateState();
    }
  }, { passive: false });

  canvas.addEventListener('touchend', () => {
    drag.active = false;
  });

  // Inertia animation
  function animate() {
    requestAnimationFrame(animate);

    if (!drag.active && (Math.abs(drag.velocityLat) > 0.01 || Math.abs(drag.velocityLon) > 0.01)) {
      camera.lon += drag.velocityLon;
      camera.lat += drag.velocityLat;
      camera.lat = Math.max(-89, Math.min(89, camera.lat));

      drag.velocityLat *= friction;
      drag.velocityLon *= friction;

      updateState();
    }
  }
  animate();

  // Initial cursor
  canvas.style.cursor = 'grab';

  function updateState() {
    optionsService.update(draft => {
      draft.viewState.lat = camera.lat;
      draft.viewState.lon = camera.lon;
      draft.viewState.altitude = (camera.distance - 1) * EARTH_RADIUS_KM;
    });
  }
}
