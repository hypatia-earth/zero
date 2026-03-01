import type { Plugin } from 'vite';

/**
 * Vite plugin to proxy GeoNames reverse geocoding API.
 * Allows publisher with geonames account to decorate captured media
 * with geographic details (city, country, ocean/sea name).
 * Activated only when VITE_GEONAMES_USER is set in .env.local.
 * Exposes /api/geocode?lat=X&lon=Y on the dev server.
 */
export function geonamesProxy(env: Record<string, string>): Plugin | null {
  const username = env.VITE_GEONAMES_USER;
  if (!username) return null;

  return {
    name: 'geonames-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/geocode?')) return next();

        const params = new URLSearchParams(req.url.split('?')[1]);
        const lat = params.get('lat');
        const lon = params.get('lon');
        if (!lat || !lon) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'lat and lon required' }));
          return;
        }

        try {
          const base = 'https://secure.geonames.org';

          // 1. Check land vs water
          const countryRes = await fetch(`${base}/countryCodeJSON?lat=${lat}&lng=${lon}&username=${username}`);
          const countryData = await countryRes.json();

          if (countryData.countryName) {
            // Land — find nearest city + continent (parallel)
            const [placeRes, infoRes] = await Promise.all([
              fetch(`${base}/findNearbyPlaceNameJSON?lat=${lat}&lng=${lon}&maxRows=1&username=${username}`),
              fetch(`${base}/countryInfoJSON?country=${countryData.countryCode}&username=${username}`),
            ]);
            const placeData = await placeRes.json();
            const infoData = await infoRes.json();
            const place = placeData.geonames?.[0];
            const continent = infoData.geonames?.[0]?.continentName || '';
            const admin = place?.adminName1 && place.adminName1 !== place.name ? place.adminName1 : '';
            // Format: continent, country, admin1, city
            const parts = [continent, countryData.countryName, admin, place?.name].filter(Boolean);
            const label = parts.join(', ');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ label }));
          } else {
            // Water — find ocean/sea
            const oceanRes = await fetch(`${base}/oceanJSON?lat=${lat}&lng=${lon}&username=${username}`);
            const oceanData = await oceanRes.json();
            const label = oceanData.ocean?.name || '';
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ label }));
          }
        } catch (e) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: 'GeoNames request failed' }));
        }
      });
    },
  };
}
