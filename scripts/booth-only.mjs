// Tells the booth computer's own requests from everyone else's on the network.
//
// Uploads, the camera proxy and QRIS management answer only the booth computer. Behind nginx every
// request reaches Node from 127.0.0.1, so nginx must pass the caller's address in X-Real-IP
// (deploy/nginx.conf does) and Node must listen on HOST=127.0.0.1, where nothing can skip nginx.
const loopback = (address = '') => address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.');

export function fromBoothComputer(req) {
  const forwarded = req.headers['x-real-ip'];
  return loopback(req.socket.remoteAddress) && (forwarded === undefined || loopback(String(forwarded)));
}
