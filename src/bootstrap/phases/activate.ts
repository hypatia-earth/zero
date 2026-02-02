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

  // Send initial state to worker BEFORE starting render loop
  auroraProxy.updateOptions(optionsService.options.value);
  auroraProxy.updateTime(stateService.viewState.value.time);
  auroraProxy.updateCamera(
    camera.getViewProj(),
    camera.getViewProjInverse(),
    camera.getEyePosition(),
    camera.getTanFov()
  );

  await progress.run('Starting render loop...', 0, async () => {
    auroraProxy.start();
  });

  await progress.run('Enabling controls...', 0.5, async () => {
    stateService.enableUrlSync();
  });

  // Set up camera controls
  const cameraControls = setupCameraControls(canvas, camera, stateService, configService, optionsService);

  // Update physics and forward camera to worker before each frame (single RAF loop)
  auroraProxy.setOnBeforeRender(() => {
    cameraControls.tick();  // Update physics first
    auroraProxy.updateCamera(
      camera.getViewProj(),
      camera.getViewProjInverse(),
      camera.getEyePosition(),
      camera.getTanFov()
    );
  });

  // Forward options updates to worker (reactive)
  // Track last sent to avoid duplicate messages when viewState changes but options don't
  let lastOptions = optionsService.options.value;
  effect(() => {
    const opts = optionsService.options.value;
    if (opts !== lastOptions) {
      lastOptions = opts;
      auroraProxy.updateOptions(opts);
    }
  });

  // Forward time updates to worker (reactive)
  // Track last sent to avoid duplicate messages when viewState.position changes but time doesn't
  let lastTimeMs = stateService.viewState.value.time.getTime();
  effect(() => {
    const time = stateService.viewState.value.time;
    const timeMs = time.getTime();
    if (timeMs !== lastTimeMs) {
      lastTimeMs = timeMs;
      auroraProxy.updateTime(time);
    }
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

  // Set up perf panel updates (lazy-cache elements since panel mounts after activate)
  let perfEls: Record<string, HTMLElement | null> | null = null;
  auroraProxy.setOnPerfUpdate((stats) => {
    // Cache elements on first successful query
    if (!perfEls) {
      const fps = document.querySelector<HTMLElement>('.perf-fps');
      if (!fps) return;  // Panel not mounted yet
      perfEls = {
        fps,
        frame: document.querySelector<HTMLElement>('.perf-frame'),
        pass: document.querySelector<HTMLElement>('.perf-pass'),
        screen: document.querySelector<HTMLElement>('.perf-screen'),
        globe: document.querySelector<HTMLElement>('.perf-globe'),
      };
    }

    if (perfEls.fps) perfEls.fps.textContent = `${stats.fps.toFixed(0)}`;
    if (perfEls.frame) perfEls.frame.textContent = `${stats.frameMs.toFixed(1)} ms`;
    if (perfEls.pass && stats.passMs > 0) perfEls.pass.textContent = `${stats.passMs.toFixed(1)} ms`;
    if (perfEls.screen) perfEls.screen.textContent = `${canvas.clientWidth}×${canvas.clientHeight}`;
    if (perfEls.globe) {
      const fov = 2 * Math.atan(camera.getTanFov());
      const globeRadiusPx = Math.asin(1 / camera.distance) * (canvas.clientHeight / fov);
      perfEls.globe.textContent = `${Math.round(globeRadiusPx)} px`;
    }
  });
  window.addEventListener('pagehide', () => {
    auroraProxy.cleanup();
  });

  const keyboardService = new KeyboardServiceClass(stateService, timestepService);

  return { keyboardService, camera };
}
