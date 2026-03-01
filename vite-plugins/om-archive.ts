import type { Plugin } from 'vite';
import fs from 'fs';
import path from 'path';

/**
 * Vite plugin to serve om-events archive locally.
 * Simulates S3 bucket responses (latest.json, XML listings, .om files with Range support)
 * so Zero's discovery service can load archived weather events during development.
 */
export function omArchive(): Plugin | null {
  const archiveDir = path.resolve('../om-events');
  if (!fs.existsSync(archiveDir)) return null;

  const events = fs.readdirSync(archiveDir).filter(name =>
    /^\d{4}-\d{2}-\d{2}--\d{4}-\d{2}-\d{2}$/.test(name) &&
    fs.statSync(path.join(archiveDir, name)).isDirectory()
  );
  if (events.length === 0) return null;

  console.log(`[om-archive] Serving ${events.length} event(s): ${events.join(', ')}`);

  return {
    name: 'om-archive',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url!;

        // 1. latest.json — model manifest
        const latestMatch = /^\/om-events\/([^/]+)\/([^/]+)\/latest\.json$/.exec(url);
        if (latestMatch) {
          const filePath = path.join(archiveDir, latestMatch[1]!, latestMatch[2]!, 'latest.json');
          if (!fs.existsSync(filePath)) { res.statusCode = 404; res.end(); return; }
          res.setHeader('Content-Type', 'application/json');
          res.end(fs.readFileSync(filePath, 'utf-8'));
          return;
        }

        // 2. ?list-type=2 — S3 bucket listing simulation
        if (url.includes('list-type=2')) {
          const params = new URLSearchParams(url.slice(url.indexOf('?')));
          if (params.get('list-type') !== '2') return next();
          const prefix = params.get('prefix');
          if (!prefix?.startsWith('om-events/')) return next();

          // Parse: om-events/{event}/{model}/{year}/{month}/...
          const parts = prefix.split('/');
          const event = parts[1]!;
          const model = parts[2]!;
          // Convert path segments to listing filename: 2026/02/24/ → 2026-02-24.xml
          const rest = parts.slice(3).join('/').replace(/\/$/, '').replace(/\//g, '-');
          const xmlPath = path.join(archiveDir, event, model, '_listings', rest + '.xml');
          if (!fs.existsSync(xmlPath)) {
            res.setHeader('Content-Type', 'application/xml');
            res.end('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult></ListBucketResult>');
            return;
          }

          // Rewrite S3 prefixes to local archive paths
          const xml = fs.readFileSync(xmlPath, 'utf-8')
            .replace(/data_spatial\//g, `om-events/${event}/`);
          res.setHeader('Content-Type', 'application/xml');
          res.end(xml);
          return;
        }

        // 3. .om files — with Range header support
        const omMatch = /^\/om-events\/(.+\.om)$/.exec(url);
        if (omMatch) {
          const filePath = path.join(archiveDir, omMatch[1]!);
          if (!fs.existsSync(filePath)) { res.statusCode = 404; res.end(); return; }

          const stat = fs.statSync(filePath);
          const range = req.headers.range;

          if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (m) {
              let start: number, end: number;
              if (m[1] === '' && m[2] !== '') {
                // bytes=-N (suffix range)
                start = Math.max(0, stat.size - parseInt(m[2]));
                end = stat.size - 1;
              } else {
                start = parseInt(m[1]!);
                end = m[2] !== '' ? parseInt(m[2]) : stat.size - 1;
              }
              res.statusCode = 206;
              res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
              res.setHeader('Content-Length', end - start + 1);
              res.setHeader('Content-Type', 'application/octet-stream');
              res.setHeader('Accept-Ranges', 'bytes');
              fs.createReadStream(filePath, { start, end }).pipe(res);
              return;
            }
          }

          // Full file response
          res.setHeader('Content-Length', stat.size);
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Accept-Ranges', 'bytes');
          fs.createReadStream(filePath).pipe(res);
          return;
        }

        next();
      });
    },
  };
}
