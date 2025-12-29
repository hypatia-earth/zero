# Zero

Browser-based weather visualization rendering ECMWF forecast data directly on a 3D globe using WebGPU.
<img src=".github/Screen-Shot-2025-12-26-at-14.48.14.png" width="800" alt="Zero screenshot">

**Live Demo:** [zero.hypatia.earth](http://zero.hypatia.earth)  
**Mirror:** [hypatia-earth.github.io/zero](https://hypatia-earth.github.io/zero/?dt=2025-12-26T14h00z&ll=0.0,0.0&alt=14000&layers=earth,sun,temp)

## What This Is

Zero visualizes professional weather hazards for climate adaptation:
- **Wet-bulb temperature** — actual heat survivability limits in humid conditions
- **Wind** — animated flow lines showing speed and direction
- **Pressure** — isobar contours revealing storm systems
- **Precipitation** — rainfall intensity

Runs entirely in your browser. No backend, no login, no tracking.

## Why It Exists

As climate extremes become more frequent, understanding forecast hazards becomes survival literacy. Zero makes professional ECMWF IFS data accessible without commercial infrastructure — forkable, self-hostable, resilient.

This is architectural independence: the tool works offline once loaded, can be hosted by communities, and doesn't depend on commercial service viability.

## Data Attribution

**Weather data provided by ECMWF** (European Centre for Medium-Range Weather Forecasts) via the [ECMWF Open Data initiative](https://www.ecmwf.int/en/forecasts/datasets/open-data).

Data accessed through [Open-Meteo's](https://open-meteo.com/) S3 mirror, hosted on [AWS Open Data](https://registry.opendata.aws/ecmwf-forecasts/).

ECMWF data is made available under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Zero is an independent project not affiliated with or endorsed by ECMWF.

## Browser Requirements

- **Chrome/Edge 113+** (recommended)
- **Safari 18+**
- **Firefox** (WebGPU behind flag, experimental)

WebGPU support required. Mobile browsers work but performance varies.

## Development

Built through human/AI collaboration:
- **Vision & architecture:** 12 years of iteration, domain expertise, design decisions
- **Implementation:** ~20,000 lines of TypeScript/WGSL written by Claude Code

This is an experiment: can domain experts build production software by collaborating with AI? Zero answers that question.

```bash
# Clone and run
git clone https://github.com/hypatia-earth/zero.git
cd zero
npm install
npm run dev
```

## Credits

**Standing on shoulders:**
- **ECMWF** — IFS forecast data via [Open Data initiative](https://www.ecmwf.int/en/forecasts/datasets/open-data)
- **Open-Meteo** — [S3 data mirror](https://open-meteo.com/)
- **Cameron Beccario** — [earth.nullschool.net](https://earth.nullschool.net) pioneered browser atmospheric visualization
- **AWS Open Data** — hosting infrastructure

## Known Limitations

- **Alpha software** — expect rough edges
- **WebGPU only** — won't work on older browsers
- **Chrome reload bug** — repeated F5 can cause adapter loss; restart browser if screen goes blank ([Chrome bug #469455157](https://issues.chromium.org/issues/469455157))
- **Bandwidth** — first load ~100-500MB depending on exploration; Service Worker caches for instant subsequent visits
- **Forecast accuracy** — displays ECMWF data but cannot guarantee correctness; consult official weather services for critical decisions

## Not Competing With

Services like Windy.com and Weather.com excel at polished UX, multi-model comparison, social features, and mobile apps. Zero focuses on hazard assessment and architectural independence for climate adaptation contexts where infrastructure matters more than feature richness.

Different missions, both valuable.

## License

MIT — see [LICENSE](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)

---

**Disclaimer:** Weather forecasts are probabilistic. Zero is provided "as is" without warranty. Not affiliated with or endorsed by ECMWF, Open-Meteo, or AWS.
