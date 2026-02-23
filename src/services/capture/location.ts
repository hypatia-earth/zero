/**
 * GeoNames reverse geocoding client
 *
 * Calls the Vite dev-server proxy at /api/geocode (see vite.config.ts).
 * Returns a human-readable location label for captured media decoration.
 */

/** Passthrough — designated place for future name cleanup */
export function formatLabel(raw: string): string {
  return raw;
}

/** Reverse-geocode lat/lon via the /api/geocode proxy. Returns "" on error. */
export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  const url = `/api/geocode?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  const res = await fetch(url);
  if (!res.ok) return '';
  const data: { label?: string } = await res.json();
  return formatLabel(data.label ?? '');
}
