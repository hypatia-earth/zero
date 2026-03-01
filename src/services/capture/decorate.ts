/**
 * Frame decoration — header/footer bars for exported media
 *
 * Renders branding (logo + URL + timestamp) in a header bar
 * and an optional location label in a footer bar.
 * Base sizes (32/24px, 14/13px font) scale with DPR when nativeDpr is enabled.
 * One OffscreenCanvas is reused across all frames.
 */

const BASE_HEADER_H = 32;
const BASE_FOOTER_H = 24;
const BASE_HEADER_FONT = 14;
const BASE_FOOTER_FONT = 13;
const BASE_ATTRIBUTION_FONT = 11;
const LOGO_PATH = '/favicon.svg';

let logoCache: Promise<HTMLImageElement> | null = null;

/** Load brand SVG as Image element — drawn directly for vector-sharp scaling. */
export function loadLogo(): Promise<HTMLImageElement> {
  if (!logoCache) {
    logoCache = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = LOGO_PATH;
    });
  }
  return logoCache;
}

export interface Decorator {
  /** Decorate a cropped RGBA frame, returns decorated RGBA (same dimensions).
   *  Optional timestampOverride replaces baked-in timestamp (for animated capture). */
  decorate(rgba: Uint8ClampedArray, timestampOverride?: string): Uint8ClampedArray;
}

/** Create a decorator. Scale > 1 for nativeDpr (e.g. 2 on Retina). */
export function createDecorator(
  w: number,
  h: number,
  label: string,
  timestamp: string,
  logo: HTMLImageElement,
  scale: number,
): Decorator {
  const headerH = Math.round(BASE_HEADER_H * scale) & ~1;
  const footerH = label.length > 0 ? (Math.round(BASE_FOOTER_H * scale) & ~1) : 0;
  const headerFont = Math.round(BASE_HEADER_FONT * scale);
  const footerFont = Math.round(BASE_FOOTER_FONT * scale);
  const attrFont = Math.round(BASE_ATTRIBUTION_FONT * scale);
  const pad = Math.round(6 * scale);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';

  // Pre-compute logo scale — fit into header bar with padding
  const logoScale = (headerH - Math.round(4 * scale)) / logo.height;
  const logoW = Math.round(logo.width * logoScale);
  const logoH = Math.round(logo.height * logoScale);
  const logoY = Math.round((headerH - logoH) / 2);
  const logoGap = Math.round(10 * scale);

  return {
    decorate(rgba: Uint8ClampedArray, timestampOverride?: string): Uint8ClampedArray {
      const ts = timestampOverride ?? timestamp;

      // ── Content ──
      const imageData = ctx.createImageData(w, h);
      imageData.data.set(rgba);
      ctx.putImageData(imageData, 0, 0);

      // ── Header overlay ──
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.fillRect(0, 0, w, headerH);
      ctx.drawImage(logo, pad, logoY, logoW, logoH);

      ctx.fillStyle = '#ffffff';
      ctx.font = `${headerFont}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText('zero.hypatia.earth', logoW + logoGap, headerH / 2);

      ctx.font = `300 ${headerFont}px 'IBM Plex Mono', monospace`;
      ctx.textAlign = 'right';
      ctx.fillText(ts, w - pad, headerH / 2);

      // ── Attribution (above footer) ──
      ctx.fillStyle = '#ffffff';
      ctx.font = `${attrFont}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'right';
      ctx.fillText('Data: ECMWF IFS \u00b7 CC BY 4.0', w - pad, h - footerH - Math.round(4 * scale));

      // ── Footer overlay ──
      if (footerH > 0) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(0, h - footerH, w, footerH);
        ctx.fillStyle = '#ffffff';
        ctx.font = `${footerFont}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(label, w / 2, h - footerH / 2);
      }

      return ctx.getImageData(0, 0, w, h).data;
    },
  };
}
