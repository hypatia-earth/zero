<!-- Style guide: /docs/zero/zero--styles.md -->

**Contents:** [About](#about) · [Hazardous Weather](#hazardous-weather) · [Controls](#controls) · [Data](#data) · [Install](#install-as-app) · [Tips](#tips) · [Quirks](#quirks) · [How it's Made](#how-its-made)

## About

**Zero democratizes access to the world's best weather data.**

Hypatia Zero visualizes global weather in your browser using WebGPU.

[ECMWF](https://www.ecmwf.int/) runs the world's most accurate weather model four times daily. Since [October 2025](https://www.ecmwf.int/en/about/media-centre/news/2025/ecmwf-makes-its-entire-real-time-catalogue-open-all), this data is [openly published](https://www.ecmwf.int/en/forecasts/datasets/open-data) under CC-BY-4.0. Zero downloads it directly into your browser—no backend, no accounts, just you and the atmosphere.

Scrub through 10 days of weather. Watch storms form and dissolve. Every minute interpolated, every layer rendered on the GPU.

### Layers

- **Temperature** at 2 meters
- **Precipitation** rate
- **Clouds** total cover
- **Humidity** relative
- **Wind** at 10 meters
- **Pressure** at sea level

## Hazardous Weather

### Wind

Wind speed visualization uses [Beaufort Scale](https://en.wikipedia.org/wiki/Beaufort_scale) thresholds adopted by [WMO](https://severeweather.wmo.int/). Lines are white below 17 m/s and turn increasingly red as wind becomes hazardous.

| Force | Speed | Effect | Color |
|-------|-------|--------|-------|
| 0-7 | 0-17 m/s | Safe to moderate | White |
| 8 (Gale) | 17-20 m/s | Walking difficult | Light red |
| 9 (Strong Gale) | 20-24 m/s | Structural damage | Red |
| 10+ (Storm) | 24+ m/s | Trees uprooted, danger | Full red |

Sources: [NWS Wind Warnings](https://www.weather.gov/safety/wind-ww) · [Beaufort Scale](https://en.wikipedia.org/wiki/Beaufort_scale)

## Controls

| Action | Mouse | Touch |
|--------|-------|-------|
| Rotate | Drag | One finger |
| Zoom | Scroll | Pinch |
| Time | Click timebar | Click timebar |

| Keyboard | Step |
|----------|------|
| ← / → | Previous/next timestep |
| Shift + ← / → | ±10 min |
| Alt + ← / → | ±24 hours |
| Alt + Shift + ← / → | ±1 min |
| F | Fullscreen |

## Data

Weather data flows from [ECMWF](https://www.ecmwf.int/) via [Open-Meteo](https://open-meteo.com/), hosted on AWS S3. The [Open Data Sponsorship Program](https://registry.opendata.aws/) covers egress costs.

Zero fetches data directly from AWS into your browser cache, then uploads it to GPU memory. No intermediary servers.

## Install as App

For fullscreen experience, install as a Progressive Web App:

| Platform | How |
|----------|-----|
| Chrome / Edge | Install icon in address bar, or Menu → "Install Hypatia Zero" |
| Android | Menu → "Add to Home Screen" |
| iOS Safari | Share → "Add to Home Screen" |

## Tips

**Not all combinations work equally well.** Basemaps and weather layers use different color palettes. Some combinations provide better contrast than others. Experiment with basemap and palette settings to find what works best for the data you're viewing.

## Quirks

**Download ETA is approximate.** Caching, bandwidth, and file sizes vary. The estimate improves as downloads progress.

![Download indicator](info/download-eta.png)

**Interpolation artifacts.** When navigating with Shift/Alt modifiers, the time can land between timesteps. Zero interpolates between two data snapshots. This works well for slowly changing parameters like temperature. Fast-moving features (storm fronts, rain cells) may show ghosting or smearing, especially when timesteps are more than 1 hour apart. Use plain arrow keys to snap to exact timesteps and avoid artifacts.

## How it's Made

Zero is a human/AI collaboration:

| Aspect | Human |
|--------|-------|
| Idea | 100% |
| Architecture | 99% |
| Requirements | 95% |
| Research | 20% |
| Writing | 5% |
| Code | 0% |

Thanks to [Claude](https://claude.ai/) and [Gemini](https://gemini.google.com/) for peaceful collaboration.

### Built With

[WebGPU](https://www.w3.org/TR/webgpu/) · [TypeScript](https://www.typescriptlang.org/) · [Mithril.js](https://mithril.js.org/) · [Zod](https://zod.dev/) · [Preact Signals](https://preactjs.com/guide/v10/signals/) · [Immer](https://immerjs.github.io/immer/) · [Marked](https://marked.js.org/) · [Vite](https://vite.dev/)

### Named After

[Hypatia of Alexandria](https://en.wikipedia.org/wiki/Hypatia) — mathematician, astronomer, philosopher. Logo from [SNL](https://snl.no/Hypatia).
