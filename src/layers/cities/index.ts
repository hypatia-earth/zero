import { defineLayer, withType, withUI, withOptions, withBlend, withRender, withConfig, asBuiltIn } from '../../services/layer/builder';

export const layer = defineLayer('cities',
  withType('decoration'),
  withUI('Cities', 'Cities', 'reference'),
  withOptions([
    'cities.enabled',
    'cities.opacity',
  ]),
  withBlend('blendCities'),
  withConfig({
    lodLevels: [
      { minPopulation: 5_000_000,  zoomInPx: 0,   zoomOutPx: 0 },
      { minPopulation: 1_000_000,  zoomInPx: 200,  zoomOutPx: 170 },
      { minPopulation: 300_000,    zoomInPx: 400,  zoomOutPx: 350 },
      { minPopulation: 100_000,    zoomInPx: 600,  zoomOutPx: 550 },
    ],
  }),
  withRender({
    pass: 'surface',
    order: 25,
  }),
  asBuiltIn(),
);
