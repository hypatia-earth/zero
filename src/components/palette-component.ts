/**
 * PaletteComponent - Renders a color palette with labels on canvas
 */

import m from 'mithril';

export interface PaletteStop {
  value: number | null;
  color: [number, number, number];
  alpha?: number;
}

export interface PaletteData {
  name: string;
  unit: string;
  interpolate?: boolean;
  stops: PaletteStop[];
}

interface PaletteComponentAttrs {
  palette: PaletteData;
  width?: number;
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

/** Calculate which labels to show (first, last, evenly spaced middle) */
function calculateLabels(
  stops: PaletteStop[],
  width: number,
  ctx: CanvasRenderingContext2D
): { text: string; x: number; width: number; index: number }[] {
  if (stops.length === 0) return [];

  const labels = stops.map((stop, i) => {
    const text = formatLabel(stop.value);
    const metrics = ctx.measureText(text);
    const x = stops.length > 1 ? (width * i) / (stops.length - 1) : width / 2;
    return { text, x, width: metrics.width, index: i };
  });

  if (labels.length <= 2) return labels;

  const result = [labels[0]!, labels[labels.length - 1]!];
  const minSpacing = 8;

  // First label is left-aligned, last is right-aligned
  const firstEnd = labels[0]!.width + minSpacing;
  const lastStart = width - labels[labels.length - 1]!.width - minSpacing;
  const availableWidth = lastStart - firstEnd;

  if (availableWidth <= 0) return result;

  const middleLabels = labels.slice(1, -1);

  // Find max labels that fit
  const canFit = (n: number): boolean => {
    if (n === 0) return true;
    if (n > middleLabels.length) return false;

    const step = middleLabels.length / (n + 1);
    const selected = Array.from({ length: n }, (_, i) =>
      middleLabels[Math.floor((i + 1) * step)]!
    );

    let prevEnd = firstEnd;
    for (const label of selected) {
      const labelStart = label.x - label.width / 2;
      if (labelStart < prevEnd) return false;
      prevEnd = label.x + label.width / 2 + minSpacing;
    }
    return prevEnd <= lastStart + minSpacing;
  };

  let maxLabels = 0;
  for (let n = middleLabels.length; n > 0; n--) {
    if (canFit(n)) {
      maxLabels = n;
      break;
    }
  }

  if (maxLabels > 0) {
    const step = middleLabels.length / (maxLabels + 1);
    for (let i = 0; i < maxLabels; i++) {
      result.push(middleLabels[Math.floor((i + 1) * step)]!);
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

  // Draw color bar (full width)
  for (let x = 0; x < width; x++) {
    const progress = x / (width - 1);
    const stopIndex = progress * (stops.length - 1);
    const idx = Math.min(Math.floor(stopIndex), stops.length - 2);

    let color: [number, number, number];
    if (interpolate) {
      const t = stopIndex - idx;
      const c1 = stops[idx]!.color;
      const c2 = stops[idx + 1]!.color;
      color = [
        Math.round(c1[0] + (c2[0] - c1[0]) * t),
        Math.round(c1[1] + (c2[1] - c1[1]) * t),
        Math.round(c1[2] + (c2[2] - c1[2]) * t),
      ];
    } else {
      const nearest = Math.min(Math.round(stopIndex), stops.length - 1);
      color = stops[nearest]!.color;
    }

    const alpha = stops[Math.min(Math.round(stopIndex), stops.length - 1)]!.alpha ?? 1;
    ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
    ctx.fillRect(x, labelHeight, 1, height - labelHeight);
  }

  // Draw labels
  ctx.font = `${fontSize}px "${font}"`;
  ctx.fillStyle = labelColor;
  ctx.textBaseline = 'top';

  const labels = calculateLabels(stops, width, ctx);

  labels.forEach((label, i) => {
    let text = label.text;

    // Add unit to first label
    if (i === 0 && unit) {
      const degree = unit === 'F' || unit === 'C' ? '°' : ' ';
      text = `${text}${degree}${unit}`;
    }

    const metrics = ctx.measureText(text);

    // First label: left-aligned, last: right-aligned, middle: centered
    let textX: number;
    if (i === 0) {
      textX = 0;
    } else if (i === labels.length - 1) {
      textX = width - metrics.width;
    } else {
      textX = label.x - metrics.width / 2;
    }

    ctx.fillText(text, textX, 2);
  });
}

export const PaletteComponent: m.ClosureComponent<PaletteComponentAttrs> = () => {
  return {
    view({ attrs }) {
      const {
        palette,
        width = 400,
        height = 40,
        font = 'Inter',
        fontSize = 12,
        color = '#000000',
      } = attrs;

      return m('canvas.palette', {
        style: `width: ${width}px; height: ${height}px;`,
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
