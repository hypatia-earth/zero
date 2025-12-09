# Test Data

Test files for shader development and debugging.

## Files

### extract-temp.js

Node.js script to fetch temperature data from Open-Meteo S3 bucket.

```bash
node extract-temp.js [date] [hour]
node extract-temp.js 2025-12-09 06
```

**Dependencies:** `@openmeteo/file-reader` (installed in parent)

**Output:** Raw Float32 binary files in `data/` folder

### data/

Raw temperature data files for GPU upload.

| File | Format | Size | Description |
|------|--------|------|-------------|
| `2025-12-09T06.temp.bin` | Float32 LE | 25.2 MB | Temperature at 06:00 UTC |
| `2025-12-09T07.temp.bin` | Float32 LE | 25.2 MB | Temperature at 07:00 UTC |

**Data format:**
- 6,599,680 Float32 values (O1280 Gaussian grid)
- Little-endian byte order
- Values in Celsius (not Kelvin)
- Range: approx -52°C to +47°C

**Usage in shader:**
```javascript
const buffer = await fetch('test/data/2025-12-09T06.temp.bin');
const data = new Float32Array(await buffer.arrayBuffer());
renderer.uploadTempData(data);
```

## Grid Layout

O1280 octahedral reduced Gaussian grid:
- 2560 latitude rings (1280 per hemisphere)
- Points per ring: 4 * ringFromPole + 16
- Total: 6,599,680 points
- Resolution: ~9 km

Data is ordered north-to-south, then west-to-east within each ring.
