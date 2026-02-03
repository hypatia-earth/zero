/**
 * Activate Phase - Start render loop and enable user input
 */

import { effect } from '@preact/signals-core';
import type { AuroraService } from '../../services/aurora-service';
import type { StateService } from '../../services/state-service';
import { KeyboardService } from '../../services/keyboard-service';
import type { ConfigService } from '../../services/config-service';
import type { OptionsService } from '../../services/options-service';
import type { TimestepService } from '../../services/timestep-service';
import type { PerfService } from '../../services/perf-service';
import type { Progress } from '../progress';
import { Camera } from '../../render/camera';
import { setupCameraControls } from '../../services/camera-controls';

export interface ActivateResult {
  keyboardService: KeyboardService;
  camera: Camera;
}

export async function runActivatePhase(
  canvas: HTMLCanvasElement,
  auroraService: AuroraService,
  stateService: StateService,
  configService: ConfigService,
  optionsService: OptionsService,
  timestepService: TimestepService,
  perfService: PerfService,
  progress: Progress
): Promise<ActivateResult> {
  // Create camera on main thread for input handling
  const cameraConfig = configService.getCameraConfig();
  const camera = new Camera(undefined, cameraConfig);
  camera.setAspect(canvas.clientWidth, canvas.clientHeight);

  // Set up camera controls
  const cameraControls = setupCameraControls(canvas, camera, stateService, configService, optionsService);

  // Set up update callback (physics + camera sync)
  let globeFrameCount = 0;
  auroraService.setUpdate(() => {
    cameraControls.tick();

    // Update camera (proxy stores for next render)
    auroraService.updateCamera(
      camera.getViewProj(),
      camera.getViewProjInverse(),
      camera.getEyePosition(),
      camera.getTanFov()
    );

    // Update globe radius in perf panel (throttled)
    if (++globeFrameCount % 10 === 0) {
      const fov = 2 * Math.atan(camera.getTanFov());
      const globeRadiusPx = Math.asin(1 / camera.distance) * (canvas.clientHeight / fov);
      perfService.setGlobe(globeRadiusPx);
    }
  });

  // Send initial options to worker BEFORE starting render loop
  // (camera and time are sent with each render message)
  auroraService.updateOptions(optionsService.options.value);

  await progress.run('Starting render loop...', 0, async () => {
    auroraService.start();
  });

  await progress.run('Enabling controls...', 0.5, async () => {
    stateService.enableUrlSync();
  });

  // Forward options updates to worker (reactive)
  // Track last sent to avoid duplicate messages when viewState changes but options don't
  let lastOptions = optionsService.options.value;
  effect(() => {
    const opts = optionsService.options.value;
    if (opts !== lastOptions) {
      lastOptions = opts;
      auroraService.updateOptions(opts);
    }
  });

  // Time is now sent with each render message (no separate effect needed)

  // Handle resize
  const updateScreen = () => {
    perfService.setScreen(canvas.clientWidth, canvas.clientHeight);
  };
  const resizeObserver = new ResizeObserver(() => {
    const dpr = window.devicePixelRatio;
    const width = canvas.clientWidth * dpr;
    const height = canvas.clientHeight * dpr;
    camera.setAspect(canvas.clientWidth, canvas.clientHeight);
    auroraService.resize(width, height);
    updateScreen();
  });
  resizeObserver.observe(canvas);
  updateScreen();  // Initial value

  // iOS standalone PWA may not fire ResizeObserver on orientation change
  window.addEventListener('resize', () => {
    const dpr = window.devicePixelRatio;
    auroraService.resize(canvas.clientWidth * dpr, canvas.clientHeight * dpr);
  });
  window.addEventListener('orientationchange', () => {
    const dpr = window.devicePixelRatio;
    auroraService.resize(canvas.clientWidth * dpr, canvas.clientHeight * dpr);
  });

  // Chrome 143+ WebGPU cleanup bug
  window.addEventListener('beforeunload', () => {
    auroraService.cleanup();
  });

  window.addEventListener('pagehide', () => {
    auroraService.cleanup();
  });

  const keyboardService = new KeyboardService(stateService, timestepService);

  return { keyboardService, camera };
}
