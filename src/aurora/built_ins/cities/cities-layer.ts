/**
 * CitiesLayer — CPU-side city label placement and GPU buffer packing
 *
 * Receives pre-loaded cities data + font metrics from worker init.
 * Builds lookup texture, city buffer, and glyph buffer for the shader.
 */

import type { CitiesLodLevel } from './cities-aurora-layer';

// ── Types ──────────────────────────────────────────────────────────────────

interface CityRecord {
  id: number;
  lat: number;   // degrees
  lon: number;   // degrees
  population: number;
  name: string;
  width: number; // pre-computed sum of xadvance at font size 42
}

interface FontChar {
  id: number;
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
  xoffset: number;
  yoffset: number;
  xadvance: number;
}

interface FontMetrics {
  common: { scaleW: number; scaleH: number; lineHeight: number; base: number };
  info: { size: number };
  distanceField: { distanceRange: number };
  chars: FontChar[];
}

/** GPU struct: 32 bytes (8 × f32) */
export interface CityLabelGPU {
  lat: number;         // radians
  lon: number;         // radians
  glyphOffset: number; // u32: index into glyph buffer
  glyphCount: number;  // u32: number of glyphs
  fontSize: number;    // f32: font size in radians
  labelWidth: number;  // f32: total label width in radians
  labelHeight: number; // f32: label height in radians
  opacity: number;     // f32: 0-1
}

/** GPU struct: 32 bytes (8 × f32) */
export interface GlyphGPU {
  atlasX: number;   // atlas pixel x
  atlasY: number;   // atlas pixel y
  atlasW: number;   // atlas pixel width
  atlasH: number;   // atlas pixel height
  advance: number;  // cumulative x advance from label start (normalized to font size)
  xOffset: number;  // glyph x offset (normalized)
  yOffset: number;  // glyph y offset (normalized)
  _pad: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

export const LOOKUP_WIDTH = 2048;
export const LOOKUP_HEIGHT = 1024;
const FONT_SIZE_RADIANS = 0.0035;  // base font size in world units
const DEG_TO_RAD = Math.PI / 180;

// Collision avoidance: label margin in degrees
const COLLISION_MARGIN_LAT = 0.3;
const COLLISION_MARGIN_LON = 0.5;

// Max font scale applied in shader — lookup texture footprint must cover this
const FONT_SCALE_MAX = 1.3;

// ── City data ──────────────────────────────────────────────────────────────

export class CitiesLayer {
  private cities: CityRecord[] = [];
  private charMap = new Map<string, FontChar>();
  private fontMetrics!: FontMetrics;

  // Current tier state
  private currentTier = -1;

  // Cached per-tier results
  private tierCache = new Map<number, {
    lookupData: Uint16Array;
    combinedBuffer: ArrayBuffer;
    cityCount: number;
    glyphStartVec4: number;
  }>();

  constructor(
    citiesDataBuffer: ArrayBuffer,
    metricsBuffer: ArrayBuffer,
    private lodLevels: CitiesLodLevel[]
  ) {
    this.parseCities(citiesDataBuffer);
    this.parseMetrics(metricsBuffer);
  }

  private parseCities(buffer: ArrayBuffer): void {
    const text = new TextDecoder().decode(buffer);
    const raw = JSON.parse(text) as Array<[number, number, number, number, string, number]>;
    this.cities = raw.map(([id, lat, lon, population, name, width]) => ({
      id, lat, lon, population, name, width,
    }));
  }

  private parseMetrics(buffer: ArrayBuffer): void {
    const text = new TextDecoder().decode(buffer);
    this.fontMetrics = JSON.parse(text) as FontMetrics;
    for (const ch of this.fontMetrics.chars) {
      this.charMap.set(ch.char, ch);
    }
  }

  /** Build buffers for a given LOD tier */
  buildTier(tierIndex: number): {
    lookupData: Uint16Array;
    combinedBuffer: ArrayBuffer;
    cityCount: number;
    glyphStartVec4: number;
  } {
    const cached = this.tierCache.get(tierIndex);
    if (cached) return cached;

    const level = this.lodLevels[tierIndex]!;
    const filtered = this.cities.filter(c => c.population >= level.minPopulation);

    // Place cities with collision avoidance
    const placed = this.placeWithCollision(filtered);

    // Build glyph data for all placed cities
    const allGlyphs: GlyphGPU[] = [];
    const cityLabels: CityLabelGPU[] = [];
    const fontSize = this.fontMetrics.info.size; // 42

    for (const city of placed) {
      const glyphOffset = allGlyphs.length;
      let cumAdvance = 0;

      for (const ch of city.name) {
        const fontChar = this.charMap.get(ch);
        if (!fontChar) continue;

        allGlyphs.push({
          atlasX: fontChar.x,
          atlasY: fontChar.y,
          atlasW: fontChar.width,
          atlasH: fontChar.height,
          advance: cumAdvance / fontSize,
          xOffset: fontChar.xoffset / fontSize,
          yOffset: fontChar.yoffset / fontSize,
          _pad: 0,
        });
        cumAdvance += fontChar.xadvance;
      }

      const glyphCount = allGlyphs.length - glyphOffset;
      const labelWidthNorm = city.width / fontSize; // width in font-size units
      const labelHeightNorm = this.fontMetrics.common.lineHeight / fontSize;

      cityLabels.push({
        lat: city.lat * DEG_TO_RAD,
        lon: city.lon * DEG_TO_RAD,
        glyphOffset,
        glyphCount,
        fontSize: FONT_SIZE_RADIANS,
        labelWidth: labelWidthNorm * FONT_SIZE_RADIANS,
        labelHeight: labelHeightNorm * FONT_SIZE_RADIANS,
        opacity: 1.0,
      });
    }

    // Build lookup texture
    const lookupData = this.buildLookupTexture(cityLabels);

    // Pack combined buffer: [cities... | glyphs...] as vec4f pairs (32 bytes each)
    // Each CityLabel = 2 vec4f, each Glyph = 2 vec4f
    const glyphStartVec4 = cityLabels.length * 2;
    const totalVec4s = (cityLabels.length + allGlyphs.length) * 2;
    const combinedBuffer = new ArrayBuffer(totalVec4s * 16);
    const view = new DataView(combinedBuffer);

    // Cities section
    for (let i = 0; i < cityLabels.length; i++) {
      const c = cityLabels[i]!;
      const off = i * 32;
      view.setFloat32(off + 0, c.lat, true);
      view.setFloat32(off + 4, c.lon, true);
      view.setUint32(off + 8, c.glyphOffset, true);
      view.setUint32(off + 12, c.glyphCount, true);
      view.setFloat32(off + 16, c.fontSize, true);
      view.setFloat32(off + 20, c.labelWidth, true);
      view.setFloat32(off + 24, c.labelHeight, true);
      view.setFloat32(off + 28, c.opacity, true);
    }

    // Glyphs section (appended after cities)
    const glyphByteOffset = cityLabels.length * 32;
    for (let i = 0; i < allGlyphs.length; i++) {
      const g = allGlyphs[i]!;
      const off = glyphByteOffset + i * 32;
      view.setFloat32(off + 0, g.atlasX, true);
      view.setFloat32(off + 4, g.atlasY, true);
      view.setFloat32(off + 8, g.atlasW, true);
      view.setFloat32(off + 12, g.atlasH, true);
      view.setFloat32(off + 16, g.advance, true);
      view.setFloat32(off + 20, g.xOffset, true);
      view.setFloat32(off + 24, g.yOffset, true);
      view.setFloat32(off + 28, 0, true); // pad
    }

    const result = { lookupData, combinedBuffer, cityCount: cityLabels.length, glyphStartVec4 };
    this.tierCache.set(tierIndex, result);
    return result;
  }

  /** Greedy collision avoidance — skip cities whose label overlaps a placed one */
  private placeWithCollision(cities: CityRecord[]): CityRecord[] {
    const placed: CityRecord[] = [];
    // Occupied bounding boxes in degrees [latMin, latMax, lonMin, lonMax]
    const boxes: [number, number, number, number][] = [];

    const fontSize = this.fontMetrics.info.size;
    const lineHeight = this.fontMetrics.common.lineHeight;

    for (const city of cities) {
      // Label dimensions in degrees (approximate)
      const labelWidthDeg = (city.width / fontSize) * (FONT_SIZE_RADIANS / DEG_TO_RAD);
      const labelHeightDeg = (lineHeight / fontSize) * (FONT_SIZE_RADIANS / DEG_TO_RAD);

      // cos(lat) compensation for longitude
      const cosLat = Math.cos(city.lat * DEG_TO_RAD);
      const lonSpan = cosLat > 0.01 ? labelWidthDeg / cosLat : labelWidthDeg;

      // Label extends east from city position (simplest quadrant)
      const box: [number, number, number, number] = [
        city.lat - COLLISION_MARGIN_LAT,
        city.lat + labelHeightDeg + COLLISION_MARGIN_LAT,
        city.lon - COLLISION_MARGIN_LON,
        city.lon + lonSpan + COLLISION_MARGIN_LON,
      ];

      // Check overlap
      let overlaps = false;
      for (const existing of boxes) {
        if (box[0] < existing[1] && box[1] > existing[0] &&
            box[2] < existing[3] && box[3] > existing[2]) {
          overlaps = true;
          break;
        }
      }

      if (!overlaps) {
        placed.push(city);
        boxes.push(box);
      }
    }

    return placed;
  }

  /** Rasterize city label footprints into R16Uint lookup texture */
  private buildLookupTexture(labels: CityLabelGPU[]): Uint16Array {
    const data = new Uint16Array(LOOKUP_WIDTH * LOOKUP_HEIGHT);

    for (let i = 0; i < labels.length; i++) {
      const label = labels[i]!;
      const latDeg = label.lat / DEG_TO_RAD;
      const lonDeg = label.lon / DEG_TO_RAD;
      const widthDeg = label.labelWidth / DEG_TO_RAD;
      const heightDeg = label.labelHeight / DEG_TO_RAD;
      const cosLat = Math.cos(label.lat);
      // Scale footprint by max font scale (shader applies up to FONT_SCALE_MAX)
      const scaledWidthDeg = widthDeg * FONT_SCALE_MAX;
      const scaledHeightDeg = heightDeg * FONT_SCALE_MAX;
      const lonSpanDeg = cosLat > 0.01 ? scaledWidthDeg / cosLat : scaledWidthDeg;

      // Footprint: indicator centered on city, label extends SE
      // Indicator half-size in degrees (matches shader: fontSize * 0.175)
      const indHalfDeg = (label.fontSize * 0.175) / DEG_TO_RAD;

      // Normalize lon to [0, 360] to match shader convention
      let lonNorm = lonDeg;
      if (lonNorm < 0) lonNorm += 360;
      const lonMinNorm = lonNorm - indHalfDeg / (cosLat > 0.01 ? cosLat : 1);
      const lonMaxNorm = lonNorm + lonSpanDeg + indHalfDeg / (cosLat > 0.01 ? cosLat : 1);
      // Generous vertical coverage: label hangs from indicator top, extends both ways
      const latMinDeg = latDeg - scaledHeightDeg;
      const latMaxDeg = latDeg + scaledHeightDeg;

      // Convert to texture pixels (shader: texX = lonDeg/360 * W, texY = (90-latDeg)/180 * H)
      const xMin = Math.floor((lonMinNorm / 360) * LOOKUP_WIDTH);
      const xMax = Math.ceil((lonMaxNorm / 360) * LOOKUP_WIDTH);
      const yMin = Math.floor(((90 - latMaxDeg) / 180) * LOOKUP_HEIGHT);
      const yMax = Math.ceil(((90 - latMinDeg) / 180) * LOOKUP_HEIGHT);

      const cityIndex = i + 1; // 1-based (0 = empty)

      for (let y = Math.max(0, yMin); y < Math.min(LOOKUP_HEIGHT, yMax); y++) {
        for (let x = xMin; x < xMax; x++) {
          // Wrap longitude
          const wx = ((x % LOOKUP_WIDTH) + LOOKUP_WIDTH) % LOOKUP_WIDTH;
          const idx = y * LOOKUP_WIDTH + wx;
          // First writer wins (higher population cities are placed first)
          if (data[idx] === 0) {
            data[idx] = cityIndex;
          }
        }
      }
    }

    return data;
  }

  get tierCount(): number { return this.lodLevels.length; }

  /** Get LOD tier for a given globe radius in pixels */
  getTierForRadius(globeRadiusPx: number): number {
    for (let i = this.lodLevels.length - 1; i >= 0; i--) {
      if (globeRadiusPx >= this.lodLevels[i]!.zoomInPx) {
        return i;
      }
    }
    return 0;
  }

  get currentTierIndex(): number { return this.currentTier; }
  set currentTierIndex(v: number) { this.currentTier = v; }
}
