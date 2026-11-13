// A stand-in Canon camera for trying DSLR setup without one. It answers the CCAPI calls the booth
// makes: device information, battery, live view frames, settings and the shutter.
//   node scripts/fake-ccapi.mjs            → http://127.0.0.1:8080
//   PORT=8081 node scripts/fake-ccapi.mjs
// In Devices → Cameras → Set up camera, pick "Canon over Wi-Fi or LAN" and type 127.0.0.1.
// Pictures are BMP, which browsers decode like JPEG; the file names still end in .JPG as a
// camera's do.
import http from 'node:http';

const port = Number(process.env.PORT || 8080);
const settings = { iso: '400', av: 'f4', tv: '1/60', wb: 'auto', exposure: '+0.0', picturestyle: 'standard' };
let shots = 0;
let pending = [];
let tick = 0;

/** A 24-bit BMP: a warm gradient with a band that moves each frame, so live view visibly runs. */
function bmp(width, height, phase, label) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(54 + row * height);
  data.write('BM', 0);
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(width, 18);
  data.writeInt32LE(height, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(row * height, 34);
  const band = (phase * 7) % width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = 54 + y * row + x * 3;
      const inBand = Math.abs(x - band) < width / 40;
      const stripe = label && y < height / 12;
      data[offset] = stripe ? 48 : inBand ? 255 : Math.round(80 + (120 * y) / height);
      data[offset + 1] = stripe ? 78 : inBand ? 255 : Math.round(110 + (90 * x) / width);
      data[offset + 2] = stripe ? 240 : inBand ? 255 : 230;
    }
  }
  return data;
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const read = (req) => new Promise((resolve) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => resolve(body ? JSON.parse(body) : {}));
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://camera');
  const path = url.pathname;
  console.log(req.method, path + url.search);
  if (path === '/ccapi/ver100/deviceinformation') return send(res, 200, { manufacturer: 'Canon', productname: 'EOS R6 (simulated)', serialnumber: 'SIM000001', firmwareversion: '1.0.0' });
  if (path === '/ccapi/ver100/devicestatus/battery') return send(res, 200, { name: 'LP-E6NH', kind: 'battery', level: 'high' });
  if (path === '/ccapi/ver100/shooting/liveview' && req.method === 'POST') return send(res, 200, {});
  if (path === '/ccapi/ver100/shooting/liveview/flip') {
    res.writeHead(200, { 'Content-Type': 'image/bmp' });
    return res.end(bmp(640, 424, tick++, false));
  }
  const setting = /^\/ccapi\/ver100\/shooting\/settings\/(\w+)$/.exec(path);
  if (setting && setting[1] in settings) {
    if (req.method === 'PUT') settings[setting[1]] = (await read(req)).value;
    return send(res, 200, { value: settings[setting[1]] });
  }
  if (path === '/ccapi/ver100/shooting/control/shutterbutton' && req.method === 'POST') {
    shots += 1;
    pending.push(`/ccapi/ver100/contents/sd/100CANON/IMG_${String(shots).padStart(4, '0')}.JPG`);
    return send(res, 200, {});
  }
  if (path === '/ccapi/ver100/event/polling') {
    const added = pending;
    pending = [];
    return send(res, 200, added.length ? { addedcontents: added } : {});
  }
  if (path.startsWith('/ccapi/ver100/contents/sd/')) {
    res.writeHead(200, { 'Content-Type': 'image/bmp' });
    return res.end(bmp(1800, 1200, shots * 40, true));
  }
  send(res, 404, { message: 'Not found' });
}).listen(port, '127.0.0.1', () => console.log(`Simulated Canon CCAPI camera at http://127.0.0.1:${port}/ccapi`));
