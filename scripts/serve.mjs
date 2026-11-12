// Serves the built app and photo files from one booth computer. Uploads are accepted only from
// its own browser; phones on the same network may read a gallery through its random token.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const dist = resolve('dist');
const data = resolve(process.env.PHOTO_DATA_DIR || '.photo-delivery');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webm': 'video/webm', '.mp4': 'video/mp4', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.task': 'application/octet-stream', '.tflite': 'application/octet-stream' };
const tokenPattern = /^[a-f0-9]{16,32}$/;
const filePattern = /^[a-zA-Z0-9-]{1,80}$/;
const maxUpload = 100 * 1024 * 1024;
const dayMs = 86_400_000;

function localAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return '127.0.0.1';
}
const publicOrigin = (process.env.PHOTO_PUBLIC_ORIGIN || `http://${localAddress()}:${port}`).replace(/\/$/, '');
/** Sent with every response: no sniffing, no framing by other sites, and photo links stay out of Referer headers. */
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
};
const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { ...SECURITY, 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const loopback = (address = '') => address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.');

async function bytes(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Upload is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serve(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/connection-test' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Booth connection</title><body style="font:18px system-ui;max-width:32rem;margin:12vh auto;padding:1.5rem"><h1>Phone connected</h1><p>This phone can reach the booth photo server. Return to the booth to start a session.</p></body></html>');
    return;
  }
  if (url.pathname === '/api/delivery-config' && req.method === 'GET') {
    return send(res, 200, { publicOrigin });
  }
  const match = /^\/api\/gallery\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (match) {
    const [, token, fileId] = match;
    if (!tokenPattern.test(token) || (fileId && !filePattern.test(fileId))) return send(res, 404, { error: 'Not found' });
    const folder = join(data, token);
    if (req.method === 'PUT' || req.method === 'POST') {
      if (!loopback(req.socket.remoteAddress)) return send(res, 403, { error: 'Uploads must come from the booth computer.' });
      await mkdir(folder, { recursive: true });
      if (req.method === 'PUT' && fileId) {
        const type = String(req.headers['content-type'] || '');
        if (!/^(image\/(png|jpeg|gif)|video\/(webm|mp4))$/.test(type)) return send(res, 415, { error: 'Unsupported file type.' });
        const body = await bytes(req, maxUpload);
        await writeFile(join(folder, fileId), body);
        await writeFile(join(folder, `${fileId}.type`), type);
        return send(res, 201, { ok: true });
      }
      if (req.method === 'POST' && !fileId) {
        const manifest = JSON.parse((await bytes(req, 16_384)).toString());
        if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 30 ||
            manifest.files.some((file) => !filePattern.test(file.id) || !filePattern.test(file.kind) || !existsSync(join(folder, file.id)))) {
          return send(res, 400, { error: 'Invalid gallery.' });
        }
        const retentionDays = Number(manifest.retentionDays);
        if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) return send(res, 400, { error: 'Invalid retention period.' });
        const safe = { brand: String(manifest.brand || '').slice(0, 100), files: manifest.files.map(({ id, kind }) => ({ id, kind })), createdAt: Date.now(), expiresAt: retentionDays ? Date.now() + retentionDays * dayMs : null };
        await writeFile(join(folder, 'manifest.json'), JSON.stringify(safe));
        return send(res, 201, { ok: true });
      }
    }
    if (req.method === 'GET') {
      if (!existsSync(join(folder, 'manifest.json'))) return send(res, 404, { error: 'Gallery not found.' });
      const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
      if (manifest.expiresAt && manifest.expiresAt <= Date.now()) return send(res, 410, { error: 'These photos have expired.' });
      if (!fileId) return send(res, 200, manifest);
      if (!manifest.files.some((file) => file.id === fileId)) return send(res, 404, { error: 'File not found.' });
      res.writeHead(200, { ...SECURITY, 'Content-Type': await readFile(join(folder, `${fileId}.type`), 'utf8'), 'Cache-Control': 'private, max-age=3600' });
      createReadStream(join(folder, fileId)).pipe(res);
      return;
    }
    return send(res, 405, { error: 'Method not allowed.' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
  const requested = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
  const file = requested.startsWith(dist + sep) && existsSync(requested) && statSync(requested).isFile() ? requested : join(dist, 'index.html');
  if (!existsSync(file)) return send(res, 404, { error: 'Build the app first with pnpm build.' });
  await sendStatic(req, res, file);
}

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.wasm', '.webmanifest']);
const compressed = new Map();
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Brotli and gzip copies of a file, made once per file version and kept in memory. */
function packed(file) {
  const { mtimeMs } = statSync(file);
  const cached = compressed.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.work;
  const work = readFile(file).then(async (raw) => ({
    br: await brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
    gzip: await gzipAsync(raw, { level: 9 }),
  }));
  compressed.set(file, { mtimeMs, work });
  return work;
}

/**
 * Hashed bundles under /assets never change, so browsers keep them a year. Everything else keeps
 * its name across builds (index.html, the wasm runtime, models, icons) and revalidates on each
 * load: an unchanged file costs a 304, and a new MediaPipe runtime never meets an old bundle.
 */
function cacheFor(file) {
  return file.startsWith(join(dist, 'assets') + sep) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

async function sendStatic(req, res, file) {
  const { size, mtimeMs } = statSync(file);
  const etag = `"${size.toString(16)}-${Math.round(mtimeMs).toString(16)}"`;
  const headers = { ...SECURITY, 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': cacheFor(file), ETag: etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const accepts = String(req.headers['accept-encoding'] || '');
  const encoding = COMPRESSIBLE.has(extname(file)) ? (/\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : null) : null;
  if (!encoding) {
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
    return;
  }
  const body = (await packed(file))[encoding];
  res.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

http.createServer((req, res) => {
  void serve(req, res).catch((error) => send(res, 500, { error: error.message }));
}).listen(port, host, () => {
  console.log(`Booth: http://127.0.0.1:${port}`);
  console.log(`Customer photo links: ${publicOrigin}`);
  // Compress the big files now, so the first booth to load the camera does not wait for it.
  for (const name of ['vision_wasm_internal.wasm', 'vision_wasm_internal.js']) {
    const file = join(dist, 'wasm', name);
    if (existsSync(file)) void packed(file);
  }
});

async function purgeExpired() {
  if (!existsSync(data)) return;
  for (const token of await readdir(data)) {
    if (!tokenPattern.test(token)) continue;
    try {
      const manifest = JSON.parse(await readFile(join(data, token, 'manifest.json'), 'utf8'));
      if (manifest.expiresAt && manifest.expiresAt <= Date.now()) await rm(join(data, token), { recursive: true, force: true });
    } catch { /* An upload still in progress has no manifest yet. */ }
  }
}
void purgeExpired();
setInterval(() => void purgeExpired(), 6 * 3_600_000);
