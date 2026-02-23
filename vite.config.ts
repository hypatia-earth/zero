import { defineConfig, type Plugin, loadEnv } from 'vite';
import fs from 'fs';
import { execSync } from 'child_process';

// Get version and git hash for build
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const gitHash = execSync('git rev-parse --short HEAD').toString().trim();

/**
 * Vite plugin to add cache headers for static assets
 */
function cacheHeaders(): Plugin {
  return {
    name: 'cache-headers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.endsWith('.dat')) {
          res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
        }
        next();
      });
    },
  };
}

/**
 * Vite plugin to serve public/external/ JS files as ES modules in dev.
 * Vite blocks dynamic import() of JS in public/; this middleware intercepts
 * the ?import query that Vite's import analysis injects and serves the raw file.
 */
function servePublicModules(): Plugin {
  return {
    name: 'serve-public-modules',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/external/') && req.url.endsWith('.js?import')) {
          const filePath = 'public' + req.url.replace('?import', '');
          if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/javascript');
            res.end(fs.readFileSync(filePath, 'utf-8'));
            return;
          }
        }
        next();
      });
    },
  };
}

/**
 * Vite plugin to proxy GeoNames reverse geocoding API.
 * Allows publisher with geonames account to decorate captured media
 * with geographic details (city, country, ocean/sea name).
 * Activated only when VITE_GEONAMES_USER is set in .env.local.
 * Exposes /api/geocode?lat=X&lon=Y on the dev server.
 */
function geonamesProxy(env: Record<string, string>): Plugin | null {
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
            // Format: continent, country, city
            const parts = [continent, countryData.countryName, place?.name].filter(Boolean);
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  return {
  base: process.env.BASE_URL || '/',
  plugins: [cacheHeaders(), servePublicModules(), geonamesProxy(env)].filter(Boolean) as Plugin[],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_HASH__: JSON.stringify(gitHash),
  },
  server: {
    host: true,  // Expose to network
    port: 5173,
    strictPort: true,
    // Allows build without certs
    https: fs.existsSync('../certs/hypatia-key.pem') ? {
      key: fs.readFileSync('../certs/hypatia-key.pem'),
      cert: fs.readFileSync('../certs/hypatia.pem'),
    } : undefined,
    fs: {
      allow: ['..'],  // Allow serving files from parent (for npm linked packages)
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    rollupOptions: {
      external: ['/external/gifenc.js'],
    },
  },
  worker: {
    format: 'es',
  },
};
});
