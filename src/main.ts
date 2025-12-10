/**
 * Hypatia Zero - Entry point
 */

import './styles/theme.css';
import './styles/layout.css';
import './styles/panels.css';
import './styles/controls.css';
import './styles/dialogs.css';
import './styles/widgets.css';

import { App } from './app';
import { setupCameraControls } from './services/camera-controls';

async function main(): Promise<void> {
  const canvas = document.getElementById('globe') as HTMLCanvasElement | null;
  if (!canvas) {
    throw new Error('Canvas element #globe not found');
  }

  // Check WebGPU support
  if (!navigator.gpu) {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;text-align:center;padding:20px;">
        <div>
          <h1 style="font-weight:300;letter-spacing:2px;">WebGPU Not Supported</h1>
          <p style="opacity:0.6;margin-top:12px;">
            Your browser does not support WebGPU.<br>
            Try Chrome 113+ or Edge 113+.
          </p>
        </div>
      </div>
    `;
    return;
  }

  const app = new App(canvas);
  await app.bootstrap();

  // Setup camera controls after bootstrap
  const renderer = app.getRenderer();
  if (renderer) {
    setupCameraControls(canvas, renderer.camera, app.getServices().state, app.getServices().config);
  }

  // Expose for debugging
  if (location.hostname === 'localhost') {
    (window as unknown as { __hypatia: object }).__hypatia = {
      app,
      ...app.getServices(),
    };
  }

  console.log('[Zero] Hypatia Zero initialized');
}

main().catch((error: unknown) => {
  console.error('[Zero] Fatal error:', error);
});
