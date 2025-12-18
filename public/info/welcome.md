# Welcome to Hypatia Zero

## Content 

**Contents:** [Features](#features) · [Controls](#controls) · [Data Source](#data-source) · [Install as App](#install-as-app) · [Known Quirks](#known-quirks) · [About](#about)

## Introdcution

Hypatia Zero is a WebGPU-powered weather visualization app.

Since Oct 2025 the ECMWF[link] openly publishes/releaes the data of it's global weather and forecatsing model. The model runs 4 times a day and produces timtimestep data up to XX hours into the future. Open-meteo[link] offers XX modell weather params in near model resolution (around 10km) in a AWS S3 buckets with 7 days rentention. AWS sponsors the egress via its XXX project.

Zero.hypatia.earth is the edge labor of hypatia.earth. It downloads ECMWF data directly into you browser cache und upload into your webGPI memory.

Zero visuslizes this data as XXX timesteps and interpolates every minute in between. You time scrub to every moment in this 10? days period and animate seamlessly forward or backward in time. Currently suppport are Temperature at 2m, Wind at 10m, precipitataion rate, totla cloud caover and humidity as weather layer. Sun, Earth and grid layer help you to orientate.

Zero uses no backend, hence the name and communicates directly with Open-Metao @ AWS only. 

## Features

- **Real-time weather data** from ECMWF
- **Temperature**, precipitation, clouds, humidity, wind, and pressure layers
- **Smooth globe navigation** with mouse and touch controls
- **Time travel** through forecast data

## Controls

| Action | Mouse | Touch |
|--------|-------|-------|app
| Rotate | Drag | One finger drag |
| Zoom | Scroll wheel | Pinch |
| Time | Click timebar | Click timebar |

## Data Source

Weather data is provided by [Open-Meteo](https://open-meteo.com/) from ECMWF IFS model forecasts.

## Install as App

For the best fullscreen experience, install Hypatia Zero as an app:

| Platform | How |
|----------|-----|
| Chrome / Edge | Click install icon in address bar, or Menu → "Install Hypatia Zero" |
| Android | Menu → "Add to Home Screen" |
| iOS Safari | Share → "Add to Home Screen" |

## Known Quirks

- **Download ETA is approximate** - Caching, bandwidth fluctuations, and varying file sizes make precise estimates impossible.

![Download indicator](info/download-eta.png)

## Background (better section title here)

Zero is a human/AI collaboration:
- Idea 100 % human
- Research 20% human
- Top Level Architecture 99% human
- Requirements management 95% human
- Requirements definitions (the actual writing) 5% human
- Development 0% human

 The human wants to thank Anthropic/Claude and Google/Gemini for peace- and fruitful collaboration

## Credits

Built with WebGPU, TypeScript, and Mithril.js, zod, signals

---
