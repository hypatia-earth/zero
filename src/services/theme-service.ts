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

/** Convert OKLCH to sRGB (0-255) */
function oklchToRgb(L: number, C: number, H: number): RGB {
  // OKLCH to Oklab
  const hRad = H * Math.PI / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  // Oklab to linear RGB
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  // Linear RGB to sRGB
  const toSrgb = (c: number) => {
    const clamped = Math.max(0, Math.min(1, c));
    return clamped <= 0.0031308
      ? Math.round(clamped * 12.92 * 255)
      : Math.round((1.055 * Math.pow(clamped, 1 / 2.4) - 0.055) * 255);
  };

  return { r: toSrgb(lr), g: toSrgb(lg), b: toSrgb(lb) };
}

/** Convert RGB to hex string */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
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
  private sizes = new Map<string, number>();

  constructor() {
    const style = getComputedStyle(document.documentElement);

    // Scan same-origin stylesheets for custom properties
    const sameOrigin = [...document.styleSheets].filter(
      sheet => sheet.href === null || sheet.href.startsWith(location.origin)
    );

    for (const sheet of sameOrigin) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSStyleRule && rule.selectorText === ':root') {
          for (const prop of rule.style) {
            const cssValue = style.getPropertyValue(prop).trim();
            if (!cssValue) continue;

            if (prop.startsWith('--color')) {
              const name = prop.slice(2); // Remove '--' prefix
              this.colors.set(name, parseColor(cssValue));
            } else if (prop.startsWith('--size')) {
              const name = prop.slice(2); // Remove '--' prefix
              this.sizes.set(name, parseFloat(cssValue));
            }
          }
        }
      }
    }

    console.log('[Theme] Loaded colors:', this.colors.size, 'sizes:', this.sizes.size);
  }

  getColor(name: string, lightness = 1.0, chroma = 1.0): Color {
    const color = this.colors.get(name);
    if (!color) throw new Error(`[Theme] Unknown color: ${name}`);

    // Return cached color if no adjustment
    if (lightness === 1.0 && chroma === 1.0) return color;

    // Adjust OKLCH and convert back
    const oklch: OKLCH = {
      l: color.oklch.l * lightness,
      c: color.oklch.c * chroma,
      h: color.oklch.h,
    };
    const rgb = oklchToRgb(oklch.l, oklch.c, oklch.h);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);

    return { hex, rgb, oklch };
  }

  getSize(name: string): number {
    const size = this.sizes.get(name);
    if (size === undefined) throw new Error(`[Theme] Unknown size: ${name}`);
    return size;
  }
}
