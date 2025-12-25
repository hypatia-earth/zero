/**
 * ThemeService - CSS custom property access for TypeScript
 *
 * Reads theme colors from CSS once at init, caches for canvas/WebGPU use.
 * Single source of truth: styles/theme.css
 */

/** Color output formats for all browser APIs */
export interface Color {
  css: string;                      // Canvas 2D fillStyle, CSS properties
  hex: string;                      // input[type=color], legacy APIs
  rgb: [number, number, number];    // WebGL/WebGPU uniforms (0-1 normalized)
}

/** Internal OKLCH representation for perceptual adjustments */
interface OKLCH { l: number; c: number; h: number }

/** Internal storage with all computed formats */
interface StoredColor {
  css: string;
  hex: string;
  rgb: [number, number, number];
  oklch: OKLCH;
}

/** Convert OKLCH to linear RGB, then to sRGB (0-1) */
function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
  // OKLCH to Oklab
  const hRad = H * Math.PI / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  // Oklab to linear RGB via LMS
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  // Linear RGB to sRGB (gamma correction)
  const toSrgb = (c: number): number => {
    const clamped = Math.max(0, Math.min(1, c));
    return clamped <= 0.0031308
      ? clamped * 12.92
      : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  };

  return [toSrgb(lr), toSrgb(lg), toSrgb(lb)];
}

/** Convert sRGB (0-1) to OKLCH */
function rgbToOklch(r: number, g: number, b: number): OKLCH {
  // sRGB to linear RGB
  const toLinear = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);

  // Linear RGB to LMS
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  // LMS to Oklab
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const bOk = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

  // Oklab to OKLCH
  const C = Math.sqrt(a * a + bOk * bOk);
  let H = Math.atan2(bOk, a) * 180 / Math.PI;
  if (H < 0) H += 360;

  return { l: L, c: C, h: H };
}

/** Convert RGB (0-1) to hex string */
function rgbToHex(rgb: [number, number, number]): string {
  const toHex = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255)
    .toString(16).padStart(2, '0');
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

/** Parse hex to RGB (0-1) */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.length === 4
    ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
    : hex;
  return [
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  ];
}

/** Parse OKLCH CSS string: oklch(70% 0.18 30) or oklch(0.7 0.18 30) */
function parseOklch(css: string): OKLCH | null {
  const match = css.match(/oklch\(([^)]+)\)/);
  if (!match) return null;

  const parts = match[1]!.trim().split(/\s+/);
  if (parts.length < 3) return null;

  let l = parseFloat(parts[0]!);
  if (parts[0]!.includes('%')) l /= 100;

  return { l, c: parseFloat(parts[1]!), h: parseFloat(parts[2]!) };
}

/** Parse rgba/rgb CSS string to RGB (0-1) */
function parseRgba(css: string): [number, number, number] | null {
  const match = css.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;

  const parts = match[1]!.split(',').map(s => parseFloat(s.trim()));
  if (parts.length < 3) return null;

  return [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255];
}

/** Build Color from OKLCH */
function colorFromOklch(oklch: OKLCH, css: string): StoredColor {
  const rgb = oklchToRgb(oklch.l, oklch.c, oklch.h);
  return { css, hex: rgbToHex(rgb), rgb, oklch };
}

/** Build Color from RGB (0-1) */
function colorFromRgb(rgb: [number, number, number], css: string): StoredColor {
  return { css, hex: rgbToHex(rgb), rgb, oklch: rgbToOklch(...rgb) };
}

/** Parse any CSS color to StoredColor */
function parseColor(cssValue: string): StoredColor {
  // OKLCH
  const oklch = parseOklch(cssValue);
  if (oklch) return colorFromOklch(oklch, cssValue);

  // Hex
  if (cssValue.startsWith('#')) {
    const rgb = hexToRgb(cssValue);
    return colorFromRgb(rgb, cssValue);
  }

  // rgba/rgb
  const rgba = parseRgba(cssValue);
  if (rgba) return colorFromRgb(rgba, cssValue);

  throw new Error(`[Theme] Unsupported color format: ${cssValue}`);
}

export class ThemeService {
  private colors = new Map<string, StoredColor>();
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
    if (lightness === 1.0 && chroma === 1.0) {
      return { css: color.css, hex: color.hex, rgb: color.rgb };
    }

    // Adjust OKLCH and compute all formats
    const oklch: OKLCH = {
      l: Math.max(0, Math.min(1, color.oklch.l * lightness)),
      c: Math.max(0, color.oklch.c * chroma),
      h: color.oklch.h,
    };
    const rgb = oklchToRgb(oklch.l, oklch.c, oklch.h);

    return {
      css: `oklch(${oklch.l} ${oklch.c} ${oklch.h})`,
      hex: rgbToHex(rgb),
      rgb,
    };
  }

  getSize(name: string): number {
    const size = this.sizes.get(name);
    if (size === undefined) throw new Error(`[Theme] Unknown size: ${name}`);
    return size;
  }
}
