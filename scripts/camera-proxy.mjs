// Forwards /api/camera/<host>:<port>/<path> to a DSLR on the venue network (Canon CCAPI) or to
// digiCamControl's web server, because neither sends the CORS headers a browser needs.
//
// It is no open proxy: only the booth computer may use it (requests from 127.0.0.1 or ::1), it
// forwards only to private IPv4 addresses, and it caps bodies and time. Shared by `pnpm serve`
// (scripts/serve.mjs) and the Vite dev server (vite.config.ts).
import http from 'node:http';

const PREFIX = /^\/api\/camera\/((\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})):(\d{1,5})(\/.*)?$/;
const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 25_000;
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

const loopback = (address = '') => address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.');

function privateIpv4(a, b, c, d) {
  if ([a, b, c, d].some((part) => part > 255)) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const refuse = (res, status, error) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error }));
};

/** Handles the request when it is for the camera proxy; returns false to let the server go on. */
export function handleCameraProxy(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const match = PREFIX.exec(url.pathname);
  if (!url.pathname.startsWith('/api/camera/')) return false;
  if (!match) {
    refuse(res, 400, 'Use /api/camera/<ip>:<port>/<path>.');
    return true;
  }
  const [, host, a, b, c, d, portText, path = '/'] = match;
  const port = Number(portText);
  if (!loopback(req.socket.remoteAddress)) return refuse(res, 403, 'Only the booth computer may reach its cameras.'), true;
  if (!privateIpv4(+a, +b, +c, +d) || port < 1 || port > 65_535) return refuse(res, 403, 'Cameras must be on the local network.'), true;
  if (!METHODS.has(req.method)) return refuse(res, 405, 'Method not allowed.'), true;

  const headers = {};
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  const upstream = http.request({ host, port, path: `${path}${url.search}`, method: req.method, headers, timeout: TIMEOUT_MS }, (reply) => {
    res.writeHead(reply.statusCode || 502, {
      'Content-Type': reply.headers['content-type'] || 'application/octet-stream',
      ...(reply.headers['content-length'] ? { 'Content-Length': reply.headers['content-length'] } : {}),
      'Cache-Control': 'no-store',
    });
    reply.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  upstream.on('error', (error) => {
    if (res.headersSent) return res.destroy();
    refuse(res, error.code === 'ETIMEDOUT' ? 504 : 502, `No answer from ${host}:${port} (${error.code || error.message}).`);
  });

  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      upstream.destroy();
      req.destroy();
    } else upstream.write(chunk);
  });
  req.on('end', () => upstream.end());
  return true;
}
