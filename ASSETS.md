# Third-Party Assets

This document lists all third-party assets used in Zero and their licenses.

## Fonts

### Inter
- **Source:** [rsms/inter](https://github.com/rsms/inter)
- **License:** SIL Open Font License 1.1 (OFL-1.1)
- **Files:** `inter-*.woff2`, `inter-*.ttf`
- **Usage:** UI text, labels

### IBM Plex Mono
- **Source:** [IBM/plex](https://github.com/IBM/plex)
- **License:** SIL Open Font License 1.1 (OFL-1.1)
- **Files:** `IBMPlexMono-Regular.json`, `plex-mono.png` (MSDF atlas)
- **Usage:** WebGPU text rendering (coordinates, values)

## Basemaps

### RTOPO2 (Topography/Bathymetry)
- **Source:** [AWI PANGAEA](https://doi.org/10.1594/PANGAEA.905360)
- **License:** CC BY 4.0
- **Files:** `basemaps/rtopo2/*.png`
- **Citation:** Schaffer et al. (2019), "The RTOPO-2 dataset"

### GMLC (Global Land Cover)
- **Source:** ESA Climate Change Initiative
- **License:** Free for research and education
- **Files:** `basemaps/gmlc/*.png`
- **Note:** Derived/processed cubemap from original dataset

### GHS-POP (Population Density)
- **Source:** [Global Human Settlement Layer](https://ghsl.jrc.ec.europa.eu/)
- **License:** CC BY 4.0
- **Files:** `basemaps/ghs-pop/*.png`
- **Citation:** European Commission, Joint Research Centre (JRC)

## Color Palettes

### Temperature Palettes
- **Files:** `palettes/temp-*.png`, `palettes/temp-*.json`
- **Source:** Custom created / derived from public domain color scales
- **License:** Public domain (Zero project)

### Precipitation Palettes
- **Files:** `palettes/rain-*.png`, `palettes/rain-*.json`
- **Source:** Custom created
- **License:** Public domain (Zero project)

## Icons

### UI Icons
- **Files:** `icon-*.svg`, `favicon.svg`
- **Source:** Custom created for Zero
- **License:** MIT (same as Zero)

## Atmosphere Precomputed Tables

### Bruneton Atmosphere Model
- **Source:** Based on [ebruneton/precomputed_atmospheric_scattering](https://github.com/ebruneton/precomputed_atmospheric_scattering)
- **License:** BSD 3-Clause
- **Files:** `atmosphere/*.dat`
- **Note:** Precomputed lookup tables for atmospheric scattering

## Data Files

### Open-Meteo WASM Decoder
- **Source:** [open-meteo/om-file-format](https://github.com/open-meteo/om-file-format)
- **License:** AGPL-3.0 (WASM binary only, not linked)
- **Files:** `om-decoder.wasm`
- **Note:** Used as standalone decoder, does not affect Zero's MIT license

### Gaussian Grid Metadata
- **Files:** `om1280/*.bin`
- **Source:** Derived from ECMWF grid specifications
- **License:** Public domain (mathematical constants)

---

## License Compatibility

All assets are compatible with Zero's MIT license:
- OFL-1.1 fonts: Allow embedding and redistribution
- CC BY 4.0: Require attribution (provided in README)
- BSD 3-Clause: Compatible with MIT
- AGPL WASM: Standalone binary, no linking

## Attribution Requirements

The following must be credited (see README.md):
- ECMWF for forecast data (CC BY 4.0)
- Open-Meteo for S3 mirror access
- ESA/JRC for basemap data where applicable
