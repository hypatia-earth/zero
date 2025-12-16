/**
 * PaletteComponent - Renders a color palette with labels on canvas
 */

import m from 'mithril';

export interface PaletteStop {
  value: number | null;
  color: [number, number, number];
  alpha?: number;
}

import type { PaletteData, LabelMode } from '../services/palette-service';
export type { PaletteData, LabelMode };

interface PaletteComponentAttrs {
  palette: PaletteData;
  width?: number | '100%';
  height?: number;
  font?: string;
  fontSize?: number;
  color?: string;
}

/** Format a value as label string */
function formatLabel(value: number | null): string {
  if (value === null) return 'max';
  if (typeof value === 'number' && Math.abs(value) < 0.01 && value !== 0) {
    return value.toFixed(4);
  }
  if (typeof value === 'number' && !Number.isInteger(value)) {
    return value.toFixed(1);
  }
  return String(value);
}

interface LabelInfo {
  text: string;
  x: number;
  width: number;
  align: 'left' | 'center' | 'right';
}

/** Calculate label positions based on labelMode */
function calculateLabels(
  stops: PaletteStop[],
  width: number,
  ctx: CanvasRenderingContext2D,
  labelMode: LabelMode,
  unit: string
): LabelInfo[] {
  if (stops.length === 0) return [];

  const values = stops.map(s => s.value).filter((v): v is number => v !== null);
  if (values.length < 2) return [];

  const minVal = values[0]!;
  const maxVal = values[values.length - 1]!;
  const range = maxVal - minVal;
  const minSpacing = 8;

  const valueToX = (v: number) => width * (v - minVal) / range;
  const degree = unit === 'F' || unit === 'C' ? '°' : ' ';

  if (labelMode === 'value-centered') {
    // Labels centered at exact value positions
    const labels: LabelInfo[] = stops.map((stop, i) => {
      const text = formatLabel(stop.value);
      const x = stop.value !== null ? valueToX(stop.value) : (i === 0 ? 0 : width);
      const align: 'left' | 'center' | 'right' = i === 0 ? 'left' : i === stops.length - 1 ? 'right' : 'center';
      return { text, x, width: ctx.measureText(text).width, align };
    });

    // Add unit to first label
    labels[0]!.text = `${labels[0]!.text}${degree}${unit}`;
    labels[0]!.width = ctx.measureText(labels[0]!.text).width;

    return filterOverlapping(labels, width, minSpacing);
  }

  if (labelMode === 'band-edge') {
    // Labels at left edge of each band
    const labels: LabelInfo[] = stops.map((stop, i) => {
      const text = formatLabel(stop.value);
      const x = stop.value !== null ? valueToX(stop.value) : (i === 0 ? 0 : width);
      // First label: left-aligned at x=0, others: just right of value position
      const align: 'left' | 'center' | 'right' = i === 0 ? 'left' : 'left';
      return { text, x, width: ctx.measureText(text).width, align };
    });

    // Add unit to first label
    labels[0]!.text = `${labels[0]!.text}${degree}${unit}`;
    labels[0]!.width = ctx.measureText(labels[0]!.text).width;

    return filterOverlapping(labels, width, minSpacing);
  }

  if (labelMode === 'band-range') {
    // Range labels centered over each band
    const labels: LabelInfo[] = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const v1 = stops[i]!.value;
      const v2 = stops[i + 1]!.value;
      if (v1 === null || v2 === null) continue;

      const text = `${formatLabel(v1)}-${formatLabel(v2)}`;
      const x1 = valueToX(v1);
      const x2 = valueToX(v2);
      const x = (x1 + x2) / 2;
      labels.push({ text, x, width: ctx.measureText(text).width, align: 'center' });
    }

    // Add unit to first label
    if (labels.length > 0) {
      labels[0]!.text = `${labels[0]!.text}${degree}${unit}`;
      labels[0]!.width = ctx.measureText(labels[0]!.text).width;
    }

    return filterOverlapping(labels, width, minSpacing);
  }

  return [];
}

/** Remove overlapping labels, keeping first, last, and as many middle as fit */
function filterOverlapping(labels: LabelInfo[], _width: number, minSpacing: number): LabelInfo[] {
  if (labels.length <= 2) return labels;

  const getExtent = (label: LabelInfo): [number, number] => {
    if (label.align === 'left') return [label.x, label.x + label.width];
    if (label.align === 'right') return [label.x - label.width, label.x];
    return [label.x - label.width / 2, label.x + label.width / 2];
  };

  const result = [labels[0]!, labels[labels.length - 1]!];

  for (let i = 1; i < labels.length - 1; i++) {
    const label = labels[i]!;
    const [start, end] = getExtent(label);

    const overlaps = result.some(existing => {
      const [eStart, eEnd] = getExtent(existing);
      return start < eEnd + minSpacing && end > eStart - minSpacing;
    });

    if (!overlaps) {
      result.push(label);
    }
  }

  return result.sort((a, b) => a.x - b.x);
}

/** Draw palette on canvas */
function drawPalette(
  canvas: HTMLCanvasElement,
  palette: PaletteData,
  font: string,
  fontSize: number,
  labelColor: string
): void {
  const ctx = canvas.getContext('2d')!;
  const dpr = globalThis.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const { stops, unit, interpolate } = palette;

  if (stops.length === 0) return;

  ctx.clearRect(0, 0, width, height);

  const labelHeight = height / 2;

  // Get value range for position mapping
  const values = stops.map(s => s.value).filter((v): v is number => v !== null);
  const minVal = values[0] ?? 0;
  const maxVal = values[values.length - 1] ?? 1;
  const range = maxVal - minVal;

  // Draw color bar (full width) - map pixel position to value
  for (let x = 0; x < width; x++) {
    const progress = x / (width - 1);
    const value = minVal + progress * range;

    // Find surrounding stops by value
    let idx = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      if (stops[i + 1]!.value !== null && value <= stops[i + 1]!.value!) {
        idx = i;
        break;
      }
      idx = i;
    }

    let color: [number, number, number];
    const stop1 = stops[idx]!;
    const stop2 = stops[idx + 1]!;
    const v1 = stop1.value ?? minVal;
    const v2 = stop2.value ?? maxVal;
    const t = v2 !== v1 ? (value - v1) / (v2 - v1) : 0;

    if (interpolate) {
      color = [
        Math.round(stop1.color[0] + (stop2.color[0] - stop1.color[0]) * t),
        Math.round(stop1.color[1] + (stop2.color[1] - stop1.color[1]) * t),
        Math.round(stop1.color[2] + (stop2.color[2] - stop1.color[2]) * t),
      ];
    } else {
      color = t < 0.5 ? stop1.color : stop2.color;
    }

    const alpha = (t < 0.5 ? stop1.alpha : stop2.alpha) ?? 1;
    ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
    ctx.fillRect(x, labelHeight, 1, height - labelHeight);
  }

  // Draw labels
  ctx.font = `${fontSize}px "${font}"`;
  ctx.fillStyle = labelColor;
  ctx.textBaseline = 'top';

  const labels = calculateLabels(stops, width, ctx, palette.labelMode, unit);

  labels.forEach(label => {
    let textX: number;
    if (label.align === 'left') {
      textX = label.x;
    } else if (label.align === 'right') {
      textX = label.x - label.width;
    } else {
      textX = label.x - label.width / 2;
    }

    // Clamp to canvas bounds
    textX = Math.max(0, Math.min(textX, width - label.width));

    ctx.fillText(label.text, textX, 2);
  });
}

export const PaletteComponent: m.ClosureComponent<PaletteComponentAttrs> = () => {
  return {
    view({ attrs }) {
      const {
        palette,
        width = '100%',
        height = 40,
        font = 'Inter',
        fontSize = 12,
        color = '#000000',
      } = attrs;

      const widthStyle = typeof width === 'number' ? `${width}px` : width;

      return m('canvas.palette', {
        style: `width: ${widthStyle}; height: ${height}px;`,
        oncreate: (vnode: m.VnodeDOM) => {
          drawPalette(vnode.dom as HTMLCanvasElement, palette, font, fontSize, color);
        },
        onupdate: (vnode: m.VnodeDOM) => {
          drawPalette(vnode.dom as HTMLCanvasElement, palette, font, fontSize, color);
        },
      });
    },
  };
};
