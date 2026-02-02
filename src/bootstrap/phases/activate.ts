/**
 * Activate Phase - Start render loop and enable user input
 */

import { effect } from '@preact/signals-core';
import type { AuroraProxy } from '../../services/aurora-proxy';
import type { StateService } from '../../services/state-service';
import type { KeyboardService } from '../../services/keyboard-service';
import type { ConfigService } from '../../services/config-service';
import type { OptionsService } from '../../services/options-service';
import type { TimestepService } from '../../services/timestep-service';
import type { Progress } from '../progress';
import { Camera } from '../../render/camera';
import { setupCameraControls } from '../../services/camera-controls';

export interface ActivateResult {
  keyboardService: KeyboardService;
  camera: Camera;
}

export async function runActivatePhase(
  canvas: HTMLCanvasElement,
  auroraProxy: AuroraProxy,
  stateService: StateService,
  configService: ConfigService,
  optionsService: OptionsService,
  KeyboardServiceClass: typeof KeyboardService,
  timestepService: TimestepService,
  progress: Progress
): Promise<ActivateResult> {
  // Create camera on main thread for input handling
  const cameraConfig = configService.getCameraConfig();
  const camera = new Camera(undefined, cameraConfig);
  camera.setAspect(canvas.clientWidth, canvas.clientHeight);

  await progress.run('Starting render loop...', 0, async () => {
    auroraProxy.start();
  });

  await progress.run('Enabling controls...', 0.5, async () => {
    stateService.enableUrlSync();
  });

  // Set up camera controls
  setupCameraControls(canvas, camera, stateService, configService, optionsService);

  // Forward camera updates to worker before each frame
  auroraProxy.setOnBeforeRender(() => {
    auroraProxy.updateCamera(
      camera.getViewProjInverse(),
      camera.getEyePosition(),
      camera.getTanFov()
    );
  });

  // Forward options updates to worker
  effect(() => {
    auroraProxy.updateOptions(optionsService.options.value);
  });

  // Forward time updates to worker
  effect(() => {
    auroraProxy.updateTime(stateService.viewState.value.time);
  });

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    const dpr = window.devicePixelRatio;
    const width = canvas.clientWidth * dpr;
    const height = canvas.clientHeight * dpr;
    camera.setAspect(canvas.clientWidth, canvas.clientHeight);
    auroraProxy.resize(width, height);
  });
  resizeObserver.observe(canvas);

  // iOS standalone PWA may not fire ResizeObserver on orientation change
  window.addEventListener('resize', () => {
    const dpr = window.devicePixelRatio;
    auroraProxy.resize(canvas.clientWidth * dpr, canvas.clientHeight * dpr);
  });
  window.addEventListener('orientationchange', () => {
    const dpr = window.devicePixelRatio;
    auroraProxy.resize(canvas.clientWidth * dpr, canvas.clientHeight * dpr);
  });

  // Chrome 143+ WebGPU cleanup bug
  window.addEventListener('beforeunload', () => {
    auroraProxy.cleanup();
  });
  window.addEventListener('pagehide', () => {
    auroraProxy.cleanup();
  });

  const keyboardService = new KeyboardServiceClass(stateService, timestepService);

  return { keyboardService, camera };
}
