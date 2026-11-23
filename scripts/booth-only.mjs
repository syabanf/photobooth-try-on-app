// Tells the booth computer's own requests from everyone else's.
//
// Uploads, the camera proxy and QRIS management answer only the booth computer. Behind nginx every
// request reaches Node from 127.0.0.1, so nginx must pass the caller's address in X-Real-IP
// (deploy/nginx.conf does) and Node must listen on HOST=127.0.0.1, where nothing can skip nginx.
//
// A web page open in the booth computer's browser also sends from 127.0.0.1. Two checks keep other
// sites out: the Host header must name this computer, which stops a hostile domain that resolves
// to 127.0.0.1 (DNS rebinding), and the browser must say the request came from this app's own pages.
const loopback = (address = '') => address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.');
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * False when a browser sent the request from another site's page. Apps without a browser, such as
 * the phone that forwards payment notifications, send neither header and pass.
 */
export function sameSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** The caller's address: nginx's X-Real-IP when the request came through it, the socket otherwise. */
export function clientAddress(req) {
  const socket = req.socket.remoteAddress || '';
  const forwarded = req.headers['x-real-ip'];
  return loopback(socket) && forwarded !== undefined ? String(forwarded) : socket;
}

export function fromBoothComputer(req) {
  return loopback(req.socket.remoteAddress) && loopback(clientAddress(req)) && LOCAL_HOST.test(req.headers.host || '') && sameSite(req);
}
