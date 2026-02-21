import { defineLayer, withType, withUI, withOptions, withBlend, withRender, withConfig, asBuiltIn } from '../../services/layer/builder';

export interface GraticuleLodLevel {
  spacing: number;     // degrees between graticule lines (same for lon/lat)
  zoomInPx: number;    // enter this LoD when globeRadiusPx >= this
  zoomOutPx: number;   // leave this LoD when globeRadiusPx <= this
}

export const layer = defineLayer('graticule',
  withType('decoration'),
  withUI('Grid', 'Grid', 'reference'),
  withOptions(['graticule.enabled', 'graticule.opacity', 'graticule.fontSize', 'graticule.lineWidth']),
  withBlend('blendGraticule'),
  withConfig({
    labelMaxRadiusPx: 500,
    lodLevels: [
      { spacing: 30, zoomInPx: 0, zoomOutPx: 0 },
      { spacing: 20, zoomInPx: 200, zoomOutPx: 170 },
      { spacing: 15, zoomInPx: 350, zoomOutPx: 300 },
      { spacing: 10, zoomInPx: 500, zoomOutPx: 450 },
      { spacing: 5, zoomInPx: 650, zoomOutPx: 600 },
    ],
  }),
  withRender({ pass: 'surface', order: 90 }),
  asBuiltIn(),
);
