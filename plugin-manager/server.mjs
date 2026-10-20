import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const digest = value => createHash('sha256').update(value).digest();
export function createManagerServer({ api, image, password = '', allowedHosts = [] }) {
  const token = randomBytes(32).toString('hex');
  const files = new Map([
    ['/', [path.join(publicDir, 'index.html'), 'text/html; charset=utf-8']],
    ['/app.mjs', [path.join(publicDir, 'app.mjs'), 'text/javascript; charset=utf-8']],
    ['/style.css', [path.join(publicDir, 'style.css'), 'text/css; charset=utf-8']],
    ...['preact.module.js', 'hooks.module.js', 'htm.module.js'].map(name => [`/vendor/${name}`, [path.join(image, 'public/vendor', name), 'text/javascript; charset=utf-8']]),
  ]);
  const send = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      // This credential-free probe exposes only manager liveness, never game state or the CSRF token.
      // It must also work when password/hostname policy would block an ordinary unauthenticated page.
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, service: 'plugin-manager' });
      const host = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, '');
      // Passwordless local access must not be exposed through DNS rebinding.
      if (!password && !isIP(host) && host !== 'localhost' && !allowedHosts.includes(host)) return send(res, 403, { error: 'Host not allowed; configure PLUGIN_MANAGER_ALLOWED_HOSTS for this hostname' });
      if (password) {
        const authorization = req.headers.authorization || '';
        const credentials = authorization.startsWith('Basic ') ? Buffer.from(authorization.slice(6), 'base64').toString('utf8') : '';
        if (!timingSafeEqual(digest(credentials), digest(`admin:${password}`))) {
          res.setHeader('WWW-Authenticate', 'Basic realm="Plugin Manager", charset="UTF-8"');
          return send(res, 401, { error: '需要管理密码，用户名 admin' });
        }
      }
      if (req.method === 'GET' && files.has(url.pathname)) {
        const [file, mime] = files.get(url.pathname);
        res.writeHead(200, { 'Content-Type': mime });
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { ...api.state(), csrf: token });
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      const origin = req.headers.origin;
      if (req.headers['x-manager-token'] !== token || origin && new URL(origin).host !== req.headers.host ||
          req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Invalid management request origin/token' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'Expected JSON' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) { send(res, 413, { error: 'Request too large' }); return; }
      }
      const result = api.start(url.pathname.slice(5), JSON.parse(body || '{}'));
      send(res, 202, result);
    } catch (error) { if (!res.headersSent) send(res, error.status || 400, { error: error.message }); else res.end(); }
  });
}
