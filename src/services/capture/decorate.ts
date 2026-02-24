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
const LOGO_PATH = '/favicon.svg';

let logoBitmapCache: Promise<ImageBitmap> | null = null;

/** Rasterize brand SVG at high resolution so downscaling is always sharp. */
const LOGO_RENDER_SIZE = 256;

export function loadLogo(): Promise<ImageBitmap> {
  if (!logoBitmapCache) {
    logoBitmapCache = fetch(LOGO_PATH)
      .then(r => r.text())
      .then(svg => {
        // Re-rasterize SVG at high resolution by overriding width/height
        const scaled = svg
          .replace(/width="\d+"/, `width="${LOGO_RENDER_SIZE}"`)
          .replace(/height="\d+"/, `height="${LOGO_RENDER_SIZE}"`);
        const blob = new Blob([scaled], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        return new Promise<ImageBitmap>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            const canvas = new OffscreenCanvas(LOGO_RENDER_SIZE, LOGO_RENDER_SIZE);
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(img, 0, 0, LOGO_RENDER_SIZE, LOGO_RENDER_SIZE);
            resolve(createImageBitmap(canvas));
          };
          img.onerror = reject;
          img.src = url;
        });
      });
  }
  return logoBitmapCache;
}

export interface Decorator {
  /** Header height in pixels (scaled by DPR) */
  headerH: number;
  /** Footer height in pixels (0 if no label) */
  footerH: number;
  /** Total output height (content + header + optional footer) */
  height: number;
  /** Decorate a cropped RGBA frame, returns decorated RGBA */
  decorate(rgba: Uint8ClampedArray): Uint8ClampedArray;
}

/** Create a decorator. Scale > 1 for nativeDpr (e.g. 2 on Retina). */
export function createDecorator(
  w: number,
  h: number,
  label: string,
  timestamp: string,
  logo: ImageBitmap,
  scale: number,
): Decorator {
  const headerH = Math.round(BASE_HEADER_H * scale) & ~1;
  const footerH = label.length > 0 ? (Math.round(BASE_FOOTER_H * scale) & ~1) : 0;
  const headerFont = Math.round(BASE_HEADER_FONT * scale);
  const footerFont = Math.round(BASE_FOOTER_FONT * scale);
  const pad = Math.round(6 * scale);
  const totalH = headerH + h + footerH;

  const canvas = new OffscreenCanvas(w, totalH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  // Pre-compute logo scale — fit into header with padding
  const logoScale = (headerH - Math.round(4 * scale)) / logo.height;
  const logoW = Math.round(logo.width * logoScale);
  const logoH = Math.round(logo.height * logoScale);
  const logoY = Math.round((headerH - logoH) / 2);
  const logoGap = Math.round(10 * scale);

  // Temp canvas for putting RGBA pixel data (content region)
  const contentCanvas = new OffscreenCanvas(w, h);
  const contentCtx = contentCanvas.getContext('2d', { willReadFrequently: true })!;

  return {
    headerH,
    footerH,
    height: totalH,

    decorate(rgba: Uint8ClampedArray): Uint8ClampedArray {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, totalH);

      // ── Header ──
      ctx.drawImage(logo, pad, logoY, logoW, logoH);

      ctx.fillStyle = '#ffffff';
      ctx.font = `${headerFont}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText('zero.hypatia.earth', logoW + logoGap, headerH / 2);

      ctx.font = `${headerFont}px monospace`;
      ctx.textAlign = 'right';
      ctx.fillText(timestamp, w - pad, headerH / 2);

      // ── Content ──
      const imageData = contentCtx.createImageData(w, h);
      imageData.data.set(rgba);
      contentCtx.putImageData(imageData, 0, 0);
      ctx.drawImage(contentCanvas, 0, headerH);

      // ── Footer ──
      if (footerH > 0) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, headerH + h, w, footerH);
        ctx.fillStyle = '#ffffff';
        ctx.font = `${footerFont}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(label, w / 2, headerH + h + footerH / 2);
      }

      return ctx.getImageData(0, 0, w, totalH).data;
    },
  };
}
