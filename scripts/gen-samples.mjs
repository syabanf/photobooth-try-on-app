// Draws the bundled sample items and writes them as transparent PNGs. No dependencies.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/items');
const SS = 2; // supersampling factor for anti-aliasing

// ---------- PNG encoding ----------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Rasterizer ----------

class Canvas {
  constructor(width, height) {
    this.w = width * SS;
    this.h = height * SS;
    this.outW = width;
    this.outH = height;
    this.px = new Float32Array(this.w * this.h * 4);
  }

  blend(x, y, [r, g, b, a]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const dstA = this.px[i + 3];
    const outA = a + dstA * (1 - a);
    if (outA === 0) return;
    for (let c = 0; c < 3; c++) {
      const src = [r, g, b][c];
      this.px[i + c] = (src * a + this.px[i + c] * dstA * (1 - a)) / outA;
    }
    this.px[i + 3] = outA;
  }

  /** Fills every supersampled pixel whose center satisfies `inside(x, y)` in output coordinates. */
  fill(bounds, inside, color) {
    const [bx0, by0, bx1, by1] = bounds.map((v) => v * SS);
    for (let y = Math.max(0, Math.floor(by0)); y < Math.min(this.h, Math.ceil(by1)); y++) {
      for (let x = Math.max(0, Math.floor(bx0)); x < Math.min(this.w, Math.ceil(bx1)); x++) {
        if (inside((x + 0.5) / SS, (y + 0.5) / SS)) this.blend(x, y, color);
      }
    }
  }

  rect(x, y, w, h, color) {
    this.fill([x, y, x + w, y + h], (px, py) => px >= x && px < x + w && py >= y && py < y + h, color);
  }

  roundRect(x, y, w, h, r, color) {
    const inside = (px, py) => {
      if (px < x || px >= x + w || py < y || py >= y + h) return false;
      const cx = Math.min(Math.max(px, x + r), x + w - r);
      const cy = Math.min(Math.max(py, y + r), y + h - r);
      return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
    };
    this.fill([x, y, x + w, y + h], inside, color);
  }

  ellipse(cx, cy, rx, ry, color) {
    this.fill(
      [cx - rx, cy - ry, cx + rx, cy + ry],
      (px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1,
      color,
    );
  }

  ring(cx, cy, rx, ry, thickness, color) {
    const irx = rx - thickness;
    const iry = ry - thickness;
    this.fill(
      [cx - rx, cy - ry, cx + rx, cy + ry],
      (px, py) =>
        ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1 &&
        ((px - cx) / irx) ** 2 + ((py - cy) / iry) ** 2 > 1,
      color,
    );
  }

  polygon(points, color) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const inside = (px, py) => {
      let hit = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    this.fill([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], inside, color);
  }

  /** Thick line between two points. */
  line(x0, y0, x1, y1, thickness, color) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const nx = (-(y1 - y0) / len) * (thickness / 2);
    const ny = ((x1 - x0) / len) * (thickness / 2);
    this.polygon([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], color);
  }

  toPng() {
    const out = new Uint8Array(this.outW * this.outH * 4);
    for (let y = 0; y < this.outH; y++) {
      for (let x = 0; x < this.outW; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const i = ((y * SS + sy) * this.w + x * SS + sx) * 4;
            const pa = this.px[i + 3];
            r += this.px[i] * pa;
            g += this.px[i + 1] * pa;
            b += this.px[i + 2] * pa;
            a += pa;
          }
        }
        const o = (y * this.outW + x) * 4;
        if (a > 0) {
          out[o] = Math.round((r / a) * 255);
          out[o + 1] = Math.round((g / a) * 255);
          out[o + 2] = Math.round((b / a) * 255);
        }
        out[o + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
    return encodePng(this.outW, this.outH, out);
  }
}

const rgba = (hex, a = 1) => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
  a,
];

// ---------- Items ----------
// Every item is drawn so its useful anchor edge matches the category pivot:
// glasses centered on the lens line, hats with the brim on the bottom edge,
// clothing with the collar near the top edge.

function glassesRound() {
  const c = new Canvas(600, 220);
  const frame = rgba('#1f1f24');
  const tint = rgba('#6aa3ff', 0.28);
  for (const cx of [150, 450]) {
    c.ellipse(cx, 110, 118, 92, tint);
    c.ring(cx, 110, 118, 92, 14, frame);
  }
  c.roundRect(262, 92, 76, 20, 10, frame); // bridge
  c.rect(0, 100, 40, 16, frame); // temple stubs
  c.rect(560, 100, 40, 16, frame);
  return c;
}

function glassesAviator() {
  const c = new Canvas(600, 240);
  const frame = rgba('#c9a24a');
  const tint = rgba('#2b2b33', 0.72);
  const lens = (cx) => [
    [cx - 130, 40], [cx + 130, 40], [cx + 118, 130], [cx + 60, 205], [cx - 40, 210], [cx - 118, 140],
  ];
  for (const cx of [150, 450]) {
    c.polygon(lens(cx), tint);
    const pts = lens(cx);
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      c.line(x0, y0, x1, y1, 9, frame);
    }
  }
  c.line(280, 48, 320, 48, 9, frame); // top bar
  c.line(280, 76, 320, 76, 7, frame); // bridge
  c.rect(0, 44, 24, 9, frame);
  c.rect(576, 44, 24, 9, frame);
  return c;
}

function hatCap() {
  const c = new Canvas(600, 360);
  const body = rgba('#c3262e');
  const dark = rgba('#8d1a20');
  c.ellipse(300, 240, 230, 200, body); // dome
  c.roundRect(70, 246, 460, 40, 20, dark); // band
  c.polygon([[110, 286], [520, 286], [590, 330], [560, 356], [100, 340]], dark); // brim
  c.ellipse(300, 40, 26, 22, dark); // button
  return c;
}

function hatBeanie() {
  const c = new Canvas(600, 400);
  const yarn = rgba('#2f5d9a');
  const fold = rgba('#244a7c');
  const pom = rgba('#e8eef7');
  c.ellipse(300, 60, 46, 46, pom);
  c.roundRect(60, 90, 480, 300, 200, yarn);
  c.rect(60, 250, 480, 150, yarn);
  c.roundRect(40, 290, 520, 110, 40, fold); // folded band
  for (let x = 70; x < 540; x += 34) c.rect(x, 300, 8, 90, rgba('#1d3b64', 0.6)); // ribbing
  return c;
}

function shirtTee() {
  const c = new Canvas(700, 800);
  const cloth = rgba('#3fa27a');
  const shade = rgba('#2f7f5f');
  c.polygon([[190, 40], [510, 40], [700, 150], [640, 300], [540, 260], [540, 800], [160, 800], [160, 260], [60, 300], [0, 150]], cloth);
  c.polygon([[0, 150], [60, 300], [160, 260], [160, 190]], shade); // sleeve shading
  c.polygon([[700, 150], [640, 300], [540, 260], [540, 190]], shade);
  c.ring(350, 30, 120, 70, 18, shade); // collar
  return c;
}

function jacketHoodie() {
  const c = new Canvas(700, 900);
  const cloth = rgba('#4a4e69');
  const shade = rgba('#393c55');
  const zip = rgba('#c9cbe0');
  c.polygon([[180, 60], [520, 60], [700, 190], [660, 430], [560, 400], [560, 900], [140, 900], [140, 400], [40, 430], [0, 190]], cloth);
  c.polygon([[0, 190], [40, 430], [140, 400], [140, 220]], shade);
  c.polygon([[700, 190], [660, 430], [560, 400], [560, 220]], shade);
  c.polygon([[200, 90], [350, 0], [500, 90], [460, 150], [350, 110], [240, 150]], shade); // hood
  c.line(350, 120, 350, 880, 10, zip);
  c.roundRect(170, 640, 110, 120, 20, shade); // pockets
  c.roundRect(420, 640, 110, 120, 20, shade);
  return c;
}

const ITEMS = {
  'glasses-round': glassesRound,
  'glasses-aviator': glassesAviator,
  'hat-cap': hatCap,
  'hat-beanie': hatBeanie,
  'shirt-tee': shirtTee,
  'jacket-hoodie': jacketHoodie,
};

mkdirSync(OUT, { recursive: true });
for (const [name, draw] of Object.entries(ITEMS)) {
  const file = resolve(OUT, `${name}.png`);
  writeFileSync(file, draw().toPng());
  console.log(`wrote ${file}`);
}
