// PBKDF2-HMAC-SHA256 in plain TypeScript, for pages served over plain HTTP on the booth network,
// where browsers hide crypto.subtle. It gives the same bytes as WebCrypto, so a password set on
// localhost still checks out from a tablet on http://192.168.x.x, and the other way round.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const w = new Uint32Array(64);

/** Runs one 64-byte block through the SHA-256 compression function, updating `state`. */
function compress(state: Uint32Array, block: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15];
    const b = w[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = 0; i < 64; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

function digest(state: Uint32Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = state[i] >>> 24;
    out[i * 4 + 1] = state[i] >>> 16;
    out[i * 4 + 2] = state[i] >>> 8;
    out[i * 4 + 3] = state[i];
  }
  return out;
}

/** SHA-256 of `data`, continuing from `start` after `prefix` bytes were already compressed. */
function sha256(data: Uint8Array, start: readonly number[] = INITIAL, prefix = 0): Uint8Array {
  const total = prefix + data.length;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const bits = total * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);
  const state = new Uint32Array(start);
  for (let offset = 0; offset < padded.length; offset += 64) compress(state, padded, offset);
  return digest(state);
}

/** PBKDF2 with HMAC-SHA256, one 32-byte block: what WebCrypto's deriveBits(…, 256) returns. */
export function pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iterations: number): Uint8Array {
  const key = new Uint8Array(64);
  key.set(password.length > 64 ? sha256(password) : password);
  // The keyed inner and outer states are fixed, so each HMAC costs two compressions, not four.
  const keyed = (pad: number) => {
    const block = key.map((byte) => byte ^ pad);
    const state = new Uint32Array(INITIAL);
    compress(state, block, 0);
    return [...state];
  };
  const inner = keyed(0x36);
  const outer = keyed(0x5c);
  const hmac = (message: Uint8Array) => sha256(sha256(message, inner, 64), outer, 64);

  const first = new Uint8Array(salt.length + 4);
  first.set(salt);
  first[salt.length + 3] = 1;
  let u = hmac(first);
  const result = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = hmac(u);
    for (let j = 0; j < 32; j++) result[j] ^= u[j];
  }
  return result;
}
