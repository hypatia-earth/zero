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
  progress: Progress
): Promise<ActivateResult> {
  // Create camera on main thread for input handling
  const cameraConfig = configService.getCameraConfig();
  const camera = new Camera(undefined, cameraConfig);
  camera.setAspect(canvas.clientWidth, canvas.clientHeight);

  // Set up camera controls
  const cameraControls = setupCameraControls(canvas, camera, stateService, configService, optionsService);

  // Set up update callback (physics + camera sync)
  auroraService.setUpdate(() => {
    cameraControls.tick();

    // Update camera (proxy stores for next render)
    auroraService.updateCamera(
      camera.getViewProj(),
      camera.getViewProjInverse(),
      camera.getEyePosition(),
      camera.getTanFov()
    );
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
  const resizeObserver = new ResizeObserver(() => {
    const dpr = window.devicePixelRatio;
    const width = canvas.clientWidth * dpr;
    const height = canvas.clientHeight * dpr;
    camera.setAspect(canvas.clientWidth, canvas.clientHeight);
    auroraService.resize(width, height);
  });
  resizeObserver.observe(canvas);

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

  // Set up perf panel updates (lazy-cache elements, throttle to every 10 frames)
  let perfEls: Record<string, HTMLElement | null> | null = null;
  let perfFrameCount = 0;
  auroraService.setOnPerfUpdate((stats) => {
    // Only update every 10 frames to reduce DOM work
    if (++perfFrameCount % 10 !== 0) return;

    // Cache elements on first successful query
    if (!perfEls) {
      const fps = document.querySelector<HTMLElement>('.perf-fps');
      if (!fps) return;  // Panel not mounted yet
      perfEls = {
        fps,
        frame: document.querySelector<HTMLElement>('.perf-frame'),
        pass: document.querySelector<HTMLElement>('.perf-pass'),
        dropped: document.querySelector<HTMLElement>('.perf-dropped'),
        screen: document.querySelector<HTMLElement>('.perf-screen'),
        globe: document.querySelector<HTMLElement>('.perf-globe'),
      };
    }

    if (perfEls.fps) perfEls.fps.textContent = `${stats.fps.toFixed(0)}`;
    if (perfEls.frame) perfEls.frame.textContent = `${stats.frameMs.toFixed(1)} ms`;
    if (perfEls.pass && stats.passMs > 0) perfEls.pass.textContent = `${stats.passMs.toFixed(1)} ms`;
    if (perfEls.dropped) perfEls.dropped.textContent = `${stats.dropped}`;
    if (perfEls.screen) perfEls.screen.textContent = `${canvas.clientWidth}×${canvas.clientHeight}`;
    if (perfEls.globe) {
      const fov = 2 * Math.atan(camera.getTanFov());
      const globeRadiusPx = Math.asin(1 / camera.distance) * (canvas.clientHeight / fov);
      perfEls.globe.textContent = `${Math.round(globeRadiusPx)} px`;
    }
  });
  window.addEventListener('pagehide', () => {
    auroraService.cleanup();
  });

  const keyboardService = new KeyboardService(stateService, timestepService);

  return { keyboardService, camera };
}
