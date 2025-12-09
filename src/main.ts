/**
 * Hypatia Zero - Entry point
 * Browser-only weather visualization with WebGPU
 */

import './styles/theme.css';
import './styles/layout.css';
import './styles/panels.css';
import './styles/controls.css';
import './styles/dialogs.css';
import './styles/widgets.css';

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
          <h1>WebGPU Not Supported</h1>
          <p style="opacity:0.6;margin-top:12px;">
            Your browser does not support WebGPU.<br>
            Try Chrome 113+ or Edge 113+.
          </p>
        </div>
      </div>
    `;
    return;
  }

  // Phase 1: Just show black canvas
  // WebGPU initialization will come in Phase 4
  console.log('[Zero] Hypatia Zero initialized');
  console.log('[Zero] Canvas:', canvas.width, 'x', canvas.height);
  console.log('[Zero] WebGPU:', navigator.gpu ? 'supported' : 'not supported');
}

main().catch((error: unknown) => {
  console.error('[Zero] Fatal error:', error);
});
