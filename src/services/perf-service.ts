/**
 * PerfService - Direct DOM updates for performance panel
 *
 * Fast, simple, no signal overhead. Caches DOM elements on first use.
 */

export class PerfService {
  private els: {
    fps: HTMLElement | null;
    frame: HTMLElement | null;
    pass1: HTMLElement | null;
    pass2: HTMLElement | null;
    pass3: HTMLElement | null;
    dropped: HTMLElement | null;
    screen: HTMLElement | null;
    globe: HTMLElement | null;
    slots: HTMLElement | null;
    pool: HTMLElement | null;
  } | null = null;

  private ensureElements(): boolean {
    if (this.els) return true;
    const fps = document.querySelector<HTMLElement>('.perf-fps');
    if (!fps) return false;  // Panel not mounted yet
    this.els = {
      fps,
      frame: document.querySelector<HTMLElement>('.perf-frame'),
      pass1: document.querySelector<HTMLElement>('.perf-pass1'),
      pass2: document.querySelector<HTMLElement>('.perf-pass2'),
      pass3: document.querySelector<HTMLElement>('.perf-pass3'),
      dropped: document.querySelector<HTMLElement>('.perf-dropped'),
      screen: document.querySelector<HTMLElement>('.perf-screen'),
      globe: document.querySelector<HTMLElement>('.perf-globe'),
      slots: document.querySelector<HTMLElement>('.perf-slots'),
      pool: document.querySelector<HTMLElement>('.perf-pool'),
    };
    return true;
  }

  setFps(value: number): void {
    if (!this.ensureElements()) return;
    if (this.els!.fps) this.els!.fps.textContent = value.toFixed(0);
  }

  setFrameMs(value: number): void {
    if (!this.ensureElements()) return;
    if (this.els!.frame) this.els!.frame.textContent = `${value.toFixed(1)} ms`;
  }

  setPass1Ms(value: number): void {
    if (!this.ensureElements()) return;
    if (this.els!.pass1) this.els!.pass1.textContent = isNaN(value) ? '—' : `${value.toFixed(2)}`;
  }

  setPass2Ms(value: number): void {
    if (!this.ensureElements()) return;
    if (this.els!.pass2) this.els!.pass2.textContent = isNaN(value) ? '—' : `${value.toFixed(2)}`;
  }

  setPass3Ms(value: number): void {
    if (!this.ensureElements()) return;
    if (this.els!.pass3) this.els!.pass3.textContent = isNaN(value) ? '—' : `${value.toFixed(2)}`;
  }

  setDropped(value: number): void {
    if (!this.ensureElements()) return;
    if (this.els!.dropped) this.els!.dropped.textContent = `${value}`;
  }

  setScreen(width: number, height: number): void {
    if (!this.ensureElements()) return;
    if (this.els!.screen) this.els!.screen.textContent = `${width}×${height}`;
  }

  setGlobe(radiusPx: number): void {
    if (!this.ensureElements()) return;
    if (this.els!.globe) this.els!.globe.textContent = `${Math.round(radiusPx)} px`;
  }

  setSlots(count: number): void {
    if (!this.ensureElements()) return;
    if (this.els!.slots) this.els!.slots.textContent = `${count}`;
  }

  setPool(count: number): void {
    if (!this.ensureElements()) return;
    if (this.els!.pool) this.els!.pool.textContent = `${count}`;
  }
}
