# Welcome to Hypatia Zero

Hypatia Zero is a WebGPU-powered weather visualization app.

**Contents:** [Features](#features) · [Controls](#controls) · [Data Source](#data-source) · [Install as App](#install-as-app) · [Known Quirks](#known-quirks) · [About](#about)

## Features

- **Real-time weather data** from ECMWF
- **Temperature**, precipitation, clouds, humidity, wind, and pressure layers
- **Smooth globe navigation** with mouse and touch controls
- **Time travel** through forecast data

## Controls

| Action | Mouse | Touch |
|--------|-------|-------|
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

## About

Built with WebGPU, TypeScript, and Mithril.js.

---

*Hypatia Zero v0.1*
