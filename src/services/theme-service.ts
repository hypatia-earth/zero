/**
 * ThemeService - CSS custom property access for TypeScript
 *
 * Reads theme colors from CSS once at init, caches for canvas/WebGPU use.
 * Single source of truth: styles/theme.css
 */

export interface RGB { r: number; g: number; b: number }
export interface OKLCH { l: number; c: number; h: number }
export interface Color {
  hex: string;
  rgb: RGB;
  oklch: OKLCH;
}

/** Convert sRGB (0-255) to OKLCH */
function rgbToOklch(r: number, g: number, b: number): OKLCH {
  // sRGB to linear RGB
  const toLinear = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);

  // Linear RGB to Oklab
  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l = Math.cbrt(l_), m = Math.cbrt(m_), s = Math.cbrt(s_);

  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bOk = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;

  // Oklab to OKLCH
  const C = Math.sqrt(a * a + bOk * bOk);
  let H = Math.atan2(bOk, a) * 180 / Math.PI;
  if (H < 0) H += 360;

  return { l: L, c: C, h: H };
}

/** Parse CSS color to Color object */
function parseColor(cssValue: string): Color {
  // Get hex via canvas (handles any CSS color format)
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = cssValue;
  const hex = ctx.fillStyle; // Returns #rrggbb

  // Parse hex to RGB
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  // Convert RGB to OKLCH
  const oklch = rgbToOklch(r, g, b);

  return { hex, rgb: { r, g, b }, oklch };
}

export class ThemeService {
  private colors = new Map<string, Color>();

  constructor() {
    const style = getComputedStyle(document.documentElement);

    // Scan same-origin stylesheets for --color custom properties
    const sameOrigin = [...document.styleSheets].filter(
      sheet => sheet.href === null || sheet.href.startsWith(location.origin)
    );

    for (const sheet of sameOrigin) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSStyleRule && rule.selectorText === ':root') {
          for (const prop of rule.style) {
            if (prop.startsWith('--color')) {
              const name = prop.slice(2); // Remove '--' prefix
              const cssValue = style.getPropertyValue(prop).trim();
              if (cssValue) {
                this.colors.set(name, parseColor(cssValue));
              }
            }
          }
        }
      }
    }

    console.log('[Theme] Loaded colors:', this.colors.size);
  }

  getColor(name: string): Color {
    const color = this.colors.get(name);
    if (!color) throw new Error(`[Theme] Unknown color: ${name}`);
    return color;
  }
}
