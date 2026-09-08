import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { BudAppData } from '../app-key-backend.mjs';

// Bind only to loopback. Expose through the owned private Bud preview whose site
// was approved with the key; never place this owner-key app behind a public URL.
export function createContactApp({ appData, keyId }) {
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-src https://www.openstreetmap.org; connect-src 'self'; base-uri 'none'; form-action 'self'");
    const send = (status, type, body) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
    try {
      if (request.method !== 'GET') return send(405, 'application/json', '{"error":"method_not_allowed"}');
      const url = new URL(request.url, 'http://localhost');
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (Object.hasOwn(assets, url.pathname)) {
        const [name, type] = assets[url.pathname];
        return send(200, type, await readFile(new URL(name, import.meta.url)));
      }
      const match = /^\/api\/(contacts(?:\/[0-9A-HJKMNP-TV-Z]{26}(?:\/(?:history|location-context))?)?)$/.exec(url.pathname);
      if (!match) return send(404, 'application/json', '{"error":"not_found"}');
      const parameters = Object.fromEntries(url.searchParams);
      if (url.search.length > 2048 || Object.keys(parameters).some(key => !['search', 'cursor', 'from', 'to'].includes(key)))
        return send(400, 'application/json', '{"error":"invalid_query"}');
      if (!match[1].includes('/') || match[1].endsWith('/history')) parameters.limit = 20;
      const result = await appData.query(keyId, match[1], parameters);
      send(200, 'application/json', JSON.stringify(result));
    } catch (error) {
      const denied = error?.code === 'app_data_permission_denied';
      send(denied ? 403 : 503, 'application/json', JSON.stringify({ error: denied ? 'permission_denied' : 'data_unavailable' }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appData = new BudAppData({ appId: process.env.BUD_APP_ID ?? 'private-contact-example', apiOrigin: process.env.BUD_API_ORIGIN });
  if (!/^dak_[0-9A-HJKMNP-TV-Z]{26}$/.test(process.env.BUD_APP_DATA_KEY_ID ?? '')) throw new Error('missing_app_key_id');
  const port = Number(process.env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  createContactApp({ appData, keyId: process.env.BUD_APP_DATA_KEY_ID }).listen(port, '127.0.0.1', () => {
    console.log(`Private contact app listening on loopback port ${port}`);
  });
}
