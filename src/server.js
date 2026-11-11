// Kleine webserver: levert het dashboard en een JSON API.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 100000) throw new Error('Te groot');
  }
  return data ? JSON.parse(data) : {};
}

export function createServer({ service, storage, password }) {
  return http.createServer(async (req, res) => {
    try {
      if (password) {
        const auth = req.headers.authorization || '';
        const given = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
        if (given !== password) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Klimaat"' });
          return res.end('Wachtwoord nodig');
        }
      }

      const url = new URL(req.url, 'http://x');
      const p = url.pathname;

      if (p === '/api/status' && req.method === 'GET') return send(res, 200, service.status());

      if (p === '/api/history' && req.method === 'GET') {
        const hours = Math.min(24 * 31, Math.max(1, Number(url.searchParams.get('hours')) || 24));
        const to = service.clock().getTime();
        const rows = storage.readHistory(to - hours * 3600000, to);
        // Uitdunnen tot max ca. 600 punten
        const step = Math.max(1, Math.ceil(rows.length / 600));
        return send(res, 200, rows.filter((_, i) => i % step === 0));
      }

      if (p === '/api/settings' && req.method === 'PUT') {
        service.updateSettings(await readBody(req));
        return send(res, 200, service.status());
      }

      if (p === '/api/override' && req.method === 'POST') {
        const { roomId, minutes } = await readBody(req);
        service.setOverride(roomId, Number(minutes) || 0);
        await service.tick();
        return send(res, 200, service.status());
      }

      if (p === '/api/away' && req.method === 'POST') {
        const { away } = await readBody(req);
        service.setAway(away);
        await service.tick();
        return send(res, 200, service.status());
      }

      if (p === '/api/refresh' && req.method === 'POST') {
        await service.tick();
        return send(res, 200, service.status());
      }

      if (req.method === 'GET') {
        const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
        if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Geen toegang' });
        try {
          const body = fs.readFileSync(file);
          return send(res, 200, body, TYPES[path.extname(file)] || 'application/octet-stream');
        } catch {
          return send(res, 404, { error: 'Niet gevonden' });
        }
      }

      send(res, 404, { error: 'Niet gevonden' });
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  });
}
