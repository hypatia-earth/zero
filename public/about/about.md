<!-- Style guide: /docs/zero/zero--styles.md -->

**Contents:** [About](#about) · [Hazardous Weather](#hazardous-weather) · [Controls](#controls) · [Data](#data) · [Install](#install-as-app) · [Tips](#tips) · [Quirks](#quirks) · [How it's Made](#how-its-made)

## About

**Zero democratizes access to the world's best weather data.**

Hypatia Zero visualizes global weather in your browser using WebGPU.

[ECMWF](https://www.ecmwf.int/) runs the world's most accurate weather model four times daily. Since [October 2025](https://www.ecmwf.int/en/about/media-centre/news/2025/ecmwf-makes-its-entire-real-time-catalogue-open-all), this data is [openly published](https://www.ecmwf.int/en/forecasts/datasets/open-data) under CC-BY-4.0. Zero downloads it directly into your browser—no backend, no accounts, just you and the atmosphere.

Scrub through up to 2 weeks of weather. Watch storms form and dissolve. Every minute interpolated, every layer rendered on the GPU.

### Layers

- **Temperature** at 2 meters
- **Precipitation** rate *(planned)*
- **Clouds** total cover *(planned)*
- **Humidity** relative *(planned)*
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

| Action         | Keyboard      | Mouse             | Touch          |
| -------------- | ------------- | ----------------- | -------------- |
| Rotate         |               | Drag              | One finger     |
| Zoom           |               | Scroll vertical   | Pinch          |
| Zoom in        |               | Double-click      | Double-tap     |
| Time ±1 step   | ← / →         |                   |                |
| Time ±10 min   | Shift + ← / → |                   |                |
| Time ±1 hour   |               | Scroll horizontal | Two-finger pan |
| Time ±24 hours | Alt + ← / →   |                   |                |
| Time select    |               | Click timebar     | Tap timebar    |
| Fullscreen     | F             |                   |                |

All input sensitivity and invert options are configurable in Settings.

## Data

Zero fetches weather data directly from AWS S3 into your browser cache, then uploads to GPU memory. No intermediary servers.

### Source

[ECMWF](https://www.ecmwf.int/) runs the Integrated Forecasting System (IFS) four times daily at 9 km resolution. Since [October 2025](https://openmeteo.substack.com/p/ecmwf-transitions-to-open-data), this data is openly published under CC-BY-4.0.

[Open-Meteo](https://open-meteo.com/) mirrors ECMWF data to AWS S3 (`s3://openmeteo`, `us-west-2`), funded by the [AWS Open Data Sponsorship Program](https://aws.amazon.com/opendata/open-data-sponsorship-program/). See [AWS Registry](https://registry.opendata.aws/open-meteo/).

### Data Window

| Aspect | Value |
|--------|-------|
| Past (analysis) | up to 7 days |
| Future (forecast) | up to 16 days |
| Resolution | 1-hourly (0-90h), 3-hourly (90-144h), 6-hourly (144h+) |
| Updates | 4 times daily |

Sources: [Open-Meteo AWS open-data](https://github.com/open-meteo/open-data) · [ECMWF Open Data](https://www.ecmwf.int/en/forecasts/datasets/open-data)

## Install as App

For fullscreen experience, install as a Progressive Web App:

| Platform | How |
|----------|-----|
| Chrome / Edge | Install icon in address bar, or Menu → "Install Hypatia Zero" |
| Android | Menu → "Add to Home Screen" |
| iOS Safari | Share → "Add to Home Screen" |

## Tips

**Not all combinations work equally well.** Basemaps and weather layers use different color palettes. Some combinations provide better contrast than others. Experiment with basemap and palette settings to find what works best for the data you're viewing.

## Known Issues

**Pressure isobars may not close.** Some contour lines appear open at the edges. Under investigation.

**Grid layer is demanding on mobile.** When zoomed in, grid rendering can slow down older mobile devices. Disable the grid layer in Settings if you experience lag.

**Download ETA is approximate.** Caching, bandwidth, and file sizes vary. The estimate improves as downloads progress.

![Download indicator](about/download-eta.png)

**Interpolation artifacts.** When navigating with Shift/Alt modifiers, the time can land between timesteps. Zero interpolates between two data snapshots. This works well for slowly changing parameters like temperature. Fast-moving features (storm fronts, rain cells) may show ghosting or smearing, especially when timesteps are more than 1 hour apart. Use plain arrow keys to snap to exact timesteps and avoid artifacts.

### Browsers

**Safari has slow initial loading.** Safari doesn't cache large static files as effectively as other browsers. If initial loading takes too long, try Firefox or Chrome—up to 3× faster on repeat visits.

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

### Credits

- **ECMWF** — IFS forecast data via [Open Data initiative](https://www.ecmwf.int/en/forecasts/datasets/open-data)
- **Open-Meteo** — [S3 data mirror](https://open-meteo.com/)
- **AWI/PANGAEA** — [RTopo-2](https://doi.pangaea.de/10.1594/PANGAEA.856844) basemap topography
- **ESRI** — [Temperature palette](https://www.esri.com/arcgis-blog/products/arcgis-pro/mapping/a-meaningful-temperature-palette) design inspiration

### Built With

[WebGPU](https://www.w3.org/TR/webgpu/) · [TypeScript](https://www.typescriptlang.org/) · [Mithril.js](https://mithril.js.org/) · [Zod](https://zod.dev/) · [Preact Signals](https://preactjs.com/guide/v10/signals/) · [Immer](https://immerjs.github.io/immer/) · [Marked](https://marked.js.org/) · [Vite](https://vite.dev/)

### Named After

[Hypatia of Alexandria](https://en.wikipedia.org/wiki/Hypatia) — mathematician, astronomer, philosopher. Logo from [SNL](https://snl.no/Hypatia).
