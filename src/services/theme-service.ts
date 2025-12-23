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

  // Parse OKLCH from original CSS (fallback to 0,0,0 if not oklch format)
  let oklch: OKLCH = { l: 0, c: 0, h: 0 };
  const match = cssValue.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (match) {
    oklch = {
      l: parseFloat(match[1]!) / 100,
      c: parseFloat(match[2]!),
      h: parseFloat(match[3]!),
    };
  }

  return { hex, rgb: { r, g, b }, oklch };
}

export class ThemeService {
  private colors = new Map<string, Color>();

  constructor() {
    const style = getComputedStyle(document.documentElement);

    // Scan all CSS custom properties starting with --color
    for (const sheet of document.styleSheets) {
      try {
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
      } catch {
        // Skip cross-origin stylesheets
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
