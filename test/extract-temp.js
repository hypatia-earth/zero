/**
 * Extract temperature data from Open-Meteo S3 for shader testing
 *
 * Fetches 2 consecutive hourly timesteps and saves as raw Float32 files.
 * Output: {timestamp}.temp.bin (6,599,680 float32 values = ~26.4MB each)
 *
 * Usage: node extract-temp.js [date] [hour]
 * Example: node extract-temp.js 2025-12-11 12
 */

import { OmFileReader, OmHttpBackend, OmDataType } from '@openmeteo/file-reader';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const BASE_URL = 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs';

// Parse args
const dateArg = process.argv[2] || new Date().toISOString().slice(0, 10);
const hourArg = parseInt(process.argv[3] || '12', 10);

// Build URLs for 2 consecutive hours
function buildUrl(date, hour) {
  const [year, month, day] = date.split('-');
  const d = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), hour));

  // Find model run (00Z, 06Z, 12Z, 18Z) - use the one before current hour
  const runHour = Math.floor(d.getUTCHours() / 6) * 6;
  const runDate = new Date(d);
  runDate.setUTCHours(runHour, 0, 0, 0);

  const runStr = `${runDate.getUTCFullYear()}/${String(runDate.getUTCMonth() + 1).padStart(2, '0')}/${String(runDate.getUTCDate()).padStart(2, '0')}/${String(runHour).padStart(2, '0')}00Z`;
  const timestamp = d.toISOString().slice(0, 13).replace('T', 'T') + '00';

  return `${BASE_URL}/${runStr}/${timestamp}.om`;
}

async function fetchTemp(url) {
  console.log(`Fetching: ${url}`);
  const t0 = performance.now();

  const backend = new OmHttpBackend({ url });
  const reader = await OmFileReader.create(backend);

  // List available variables
  const numChildren = reader.numberOfChildren();
  console.log(`  Variables: ${numChildren}`);

  // Find temperature variable
  let tempVar = null;
  const varNames = [];
  for (let i = 0; i < numChildren; i++) {
    const child = await reader.getChild(i);
    const name = child.getName();
    varNames.push(name);
    if (name === 'temperature_2m' || name === 'temperature') {
      tempVar = child;
    }
  }

  if (!tempVar) {
    console.log(`  Available: ${varNames.join(', ')}`);
    throw new Error('No temperature variable found');
  }

  console.log(`  Found: ${tempVar.getName()}`);
  const dims = tempVar.getDimensions();
  console.log(`  Dims: ${JSON.stringify(dims)}`);

  // Read all data
  const data = await tempVar.read({
    type: OmDataType.FloatArray,
    ranges: [
      { start: BigInt(0), end: BigInt(dims[0]) },
      { start: BigInt(0), end: BigInt(dims[1]) }
    ]
  });

  console.log(`  Read: ${data.length.toLocaleString()} values in ${(performance.now() - t0).toFixed(0)}ms`);

  // Stats
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  console.log(`  Range: ${min.toFixed(1)}K to ${max.toFixed(1)}K (${(min - 273.15).toFixed(1)}°C to ${(max - 273.15).toFixed(1)}°C)`);

  return data;
}

async function main() {
  console.log(`\n=== Extracting temperature data ===`);
  console.log(`Date: ${dateArg}, Hour: ${hourArg}\n`);

  // Fetch two consecutive hours
  const url1 = buildUrl(dateArg, hourArg);
  const url2 = buildUrl(dateArg, hourArg + 1);

  const [data1, data2] = await Promise.all([
    fetchTemp(url1),
    fetchTemp(url2)
  ]);

  // Save as raw binary
  const outDir = './data';
  mkdirSync(outDir, { recursive: true });

  const file1 = `${outDir}/${dateArg}T${String(hourArg).padStart(2, '0')}.temp.bin`;
  const file2 = `${outDir}/${dateArg}T${String(hourArg + 1).padStart(2, '0')}.temp.bin`;

  writeFileSync(file1, Buffer.from(data1.buffer));
  writeFileSync(file2, Buffer.from(data2.buffer));

  console.log(`\nSaved:`);
  console.log(`  ${file1} (${(data1.byteLength / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  ${file2} (${(data2.byteLength / 1024 / 1024).toFixed(1)} MB)`);

  console.log(`\n=== Done ===\n`);
}

main().catch(console.error);
