/**
 * TestPerformanceService — In-browser GPU performance benchmark
 *
 * Measures per-layer GPU cost at multiple zoom levels.
 * Triggered via ?perftest URL param or danger zone button.
 * Results exposed on window.__perfResults for automation.
 *
 * Test matrix per zoom level:
 *   1. Baseline (no layers)
 *   2. Each layer alone
 *   3. All layers on
 *   4. All-minus-one for each layer
 */

import type { OptionsService } from './options-service';
import type { AuroraService } from './aurora-service';

// ============================================================
// Types
// ============================================================

interface PerfMetrics {
  fps: number;
  frameMs: number;
  p1: number;
  p2: number;
  p3: number;
  dropped: number;
  globePx: number;
}

interface PerfEnvironment {
  browser: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  renderScale: string;
  fpsLimit: string;
  canvasSize: { width: number; height: number };
  gpu: string;
}

interface Measurement {
  label: string;
  enabledLayers: string[];
  metrics: PerfMetrics;
}

interface ZoomResult {
  alt: number;
  zoomLabel: string;
  globePx: number;
  measurements: Measurement[];
}

export interface PerfTestReport {
  timestamp: string;
  environment: PerfEnvironment;
  zoomLevels: ZoomResult[];
}

// ============================================================
// Constants
// ============================================================

const EARTH_RADIUS_KM = 6371;
const SETTLE_MS = 2000;

const LAYERS = [
  'earth', 'sun', 'graticule', 'cities',
  'temp', 'rain', 'clouds', 'pressure', 'wind',
] as const;

const ZOOM_LEVELS = [
  { alt: 300,   label: 'close' },
  { alt: 3000,  label: 'mid' },
  { alt: 30000, label: 'far' },
] as const;

// ============================================================
// Service
// ============================================================

export class TestPerformanceService {
  private optionsService: OptionsService;
  private auroraService: AuroraService;
  private overlay: HTMLElement | null = null;
  constructor(optionsService: OptionsService, auroraService: AuroraService) {
    this.optionsService = optionsService;
    this.auroraService = auroraService;
  }

  /** Auto-run if ?perftest is present in URL */
  autoRun(): void {
    if (new URLSearchParams(location.search).has('perftest')) {
      this.run();
    }
  }

  /** Run the full benchmark */
  async run(): Promise<PerfTestReport> {
    this.showOverlay('Waiting for renderer...');

    // Ensure perf panel is active before waiting for it
    this.optionsService.update((d: any) => {
      d.debug.showPerfPanel = true;
      d.debug.fpsLimit = 'off';
      d.debug.renderScale = '1';
    });
    this.auroraService.setEngineOptions({ timeslotsPerLayer: 2 });

    // Wait for perf panel to have valid data (renderer running)
    await this.waitForPerfReady();

    // Disable all layers and let settle
    this.setLayers([]);
    await this.settle();

    const environment = this.readEnvironment();
    const zoomLevels: ZoomResult[] = [];
    const totalSteps = ZOOM_LEVELS.length * (1 + LAYERS.length + 1 + LAYERS.length);
    let step = 0;

    for (const zoom of ZOOM_LEVELS) {
      const distance = (zoom.alt + EARTH_RADIUS_KM) / EARTH_RADIUS_KM;
      this.auroraService.setCameraPosition(45, 10, distance);
      // Hide overlay and wait longer after camera change to flush 60-frame average
      if (this.overlay) this.overlay.style.display = 'none';
      await this.settleCamera();
      if (this.overlay) this.overlay.style.display = '';

      const measurements: Measurement[] = [];

      // Baseline: no layers
      this.updateProgress(++step, totalSteps, `${zoom.label}: baseline`);
      measurements.push(await this.measure('none', []));

      // Each layer alone
      for (const layer of LAYERS) {
        this.updateProgress(++step, totalSteps, `${zoom.label}: ${layer}`);
        measurements.push(await this.measure(layer, [layer]));
      }

      // All layers
      const allLayers = [...LAYERS];
      this.updateProgress(++step, totalSteps, `${zoom.label}: all`);
      measurements.push(await this.measure('all', allLayers));

      // All minus one
      for (const excluded of LAYERS) {
        this.updateProgress(++step, totalSteps, `${zoom.label}: all-minus-${excluded}`);
        const subset = allLayers.filter(l => l !== excluded);
        measurements.push(await this.measure(`all-minus-${excluded}`, subset));
      }

      const globePx = measurements[0]!.metrics.globePx;
      zoomLevels.push({ alt: zoom.alt, zoomLabel: zoom.label, globePx, measurements });
    }

    const report: PerfTestReport = {
      timestamp: new Date().toISOString(),
      environment,
      zoomLevels,
    };

    // Expose for automation
    (window as any).__perfResults = report;

    // Log summary
    const summary = this.formatSummary(report);
    console.log(summary);

    this.showResults(report, summary);

    return report;
  }

  // ============================================================
  // Private
  // ============================================================

  /** Poll until perf panel shows valid fps (renderer is running) */
  private waitForPerfReady(): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        const el = document.querySelector('.perf-fps');
        const fps = parseFloat(el?.textContent?.trim() ?? '');
        if (fps > 0) {
          resolve();
        } else {
          setTimeout(check, 200);
        }
      };
      check();
    });
  }

  private setLayers(enabled: string[]): void {
    this.optionsService.update((d: any) => {
      for (const layer of LAYERS) {
        d[layer].enabled = enabled.includes(layer);
      }
    });
  }

  private async measure(label: string, layers: string[]): Promise<Measurement> {
    // Hide overlay during measurement to prevent browser throttling rAF
    if (this.overlay) this.overlay.style.display = 'none';
    this.setLayers(layers);
    // Reset rolling averages so settle period fills with fresh samples only
    this.auroraService.resetPerfStats();
    await this.settle();
    const metrics = this.readMetrics();
    if (this.overlay) this.overlay.style.display = '';
    return { label, enabledLayers: layers, metrics };
  }

  /** Longer settle after camera change — flushes entire 60-frame averaging window */
  private settleCamera(): Promise<void> {
    return new Promise(resolve => {
      let frames = 0;
      const tick = () => {
        if (++frames >= 90) {
          resolve();
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  }

  /** Wait using rAF-aligned frames to avoid interfering with the render loop */
  private settle(): Promise<void> {
    return new Promise(resolve => {
      const start = performance.now();
      const tick = () => {
        if (performance.now() - start >= SETTLE_MS) {
          resolve();
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  }

  private readMetrics(): PerfMetrics {
    const panel = document.querySelector('.perf.panel')!;
    const text = (cls: string) => panel.querySelector(`.${cls}`)?.textContent?.trim() ?? '0';
    return {
      fps: parseFloat(text('perf-fps')),
      frameMs: parseFloat(text('perf-frame')),
      p1: parseFloat(text('perf-pass1')),
      p2: parseFloat(text('perf-pass2')),
      p3: parseFloat(text('perf-pass3')),
      dropped: parseFloat(text('perf-dropped')),
      globePx: parseFloat(text('perf-globe')),
    };
  }

  private readEnvironment(): PerfEnvironment {
    const opts = this.optionsService.options.value;
    const canvas = document.querySelector('canvas')!;
    return {
      browser: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      renderScale: opts.debug.renderScale,
      fpsLimit: opts.debug.fpsLimit,
      canvasSize: { width: canvas.width, height: canvas.height },
      gpu: (navigator as any).gpu?.adapter?.info?.device ?? 'unknown',
    };
  }

  // ============================================================
  // Overlay
  // ============================================================

  private showOverlay(text: string): void {
    if (!this.overlay) {
      this.overlay = document.createElement('div');
      Object.assign(this.overlay.style, {
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'rgba(0, 0, 0, 0.9)',
        color: '#fff',
        padding: '24px 32px',
        borderRadius: '12px',
        fontFamily: 'monospace',
        fontSize: '13px',
        whiteSpace: 'pre',
        userSelect: 'text',
        zIndex: '99999',
        maxWidth: '90vw',
        maxHeight: '90vh',
        overflow: 'auto',
      });
      document.body.appendChild(this.overlay);
    }
    this.overlay.textContent = text;

  }

  private showResults(report: PerfTestReport, summary: string): void {
    this.showOverlay(summary);

    const btnStyle = {
      display: 'inline-block',
      margin: '8px 8px 0 0',
      padding: '8px 20px',
      cursor: 'pointer',
      background: '#333',
      color: '#fff',
      border: '1px solid #666',
      borderRadius: '6px',
      fontFamily: 'monospace',
      fontSize: '13px',
    };

    const actions = document.createElement('div');
    actions.style.marginTop = '12px';

    // Copy JSON
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy JSON';
    Object.assign(copyBtn.style, btnStyle);
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 1500);
    };
    actions.appendChild(copyBtn);

    // Save JSON — use <a> styled as button to preserve user gesture for download
    const saveLink = document.createElement('a');
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    saveLink.href = URL.createObjectURL(blob);
    saveLink.download = `perf-${report.timestamp.replace(/[:.]/g, '-')}.json`;
    saveLink.textContent = 'Save JSON';
    Object.assign(saveLink.style, { ...btnStyle, textDecoration: 'none' });
    actions.appendChild(saveLink);

    // Close
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    Object.assign(closeBtn.style, btnStyle);
    closeBtn.onclick = () => { this.overlay?.remove(); this.overlay = null; };
    actions.appendChild(closeBtn);

    this.overlay!.appendChild(actions);
  }

  private updateProgress(step: number, total: number, label: string): void {
    const pct = Math.round((step / total) * 100);
    this.showOverlay(`GPU Performance Test\n\n${label}\n${step}/${total} (${pct}%)`);
  }

  // ============================================================
  // Summary
  // ============================================================

  private formatSummary(report: PerfTestReport): string {
    const pad = (s: string, n: number) => s.length >= n ? s : s + ' '.repeat(n - s.length);
    const lines: string[] = ['=== GPU Layer Impact ===\n'];

    for (const zoom of report.zoomLevels) {
      lines.push(`--- ${zoom.zoomLabel} (alt=${zoom.alt}, globe=${zoom.globePx}px) ---`);
      lines.push(pad('scenario', 20) + pad('fps', 6) + pad('frame', 8) + pad('p1', 8) + pad('p2', 8) + pad('p3', 8));
      lines.push('-'.repeat(58));

      for (const m of zoom.measurements) {
        const { fps, frameMs, p1, p2, p3 } = m.metrics;
        lines.push(
          pad(m.label, 20) +
          pad(String(fps), 6) +
          pad(frameMs.toFixed(2), 8) +
          pad(p1.toFixed(2), 8) +
          pad(p2.toFixed(2), 8) +
          pad(p3.toFixed(2), 8)
        );
      }
      lines.push('');
    }
    return lines.join('\n');
  }
}
