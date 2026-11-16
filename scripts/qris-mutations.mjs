// Matches "money received" notifications to the QRIS charges the booths are waiting on.
//
// The shop's static QRIS pays straight into its own account, so no gateway calls back. Instead a
// phone that receives the bank or wallet notifications forwards each one here; the amount in its
// text settles the one waiting charge with that exact total. Every charge gets a total no other
// waiting charge has, by adding a small unique code when two would collide.
//
// Devices on the booth network create charges and ask what was paid. Notifications need the secret
// token, since a notification is what marks money as received. Only the booth computer can read
// the token. Shared by `pnpm serve` (scripts/serve.mjs) and the Vite dev server (vite.config.ts).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';

const MAX_BODY = 8 * 1024;
const MAX_WAITING = 200;
const MAX_CODE = 99;
const KEEP_PAID_MS = 86_400_000;
/** A payment made in the QR's last seconds still counts: the notification takes a moment to arrive. */
const GRACE_MS = 120_000;
const REPEAT_MS = 60_000;
const MAX_LOG = 500;
const KEY = /^[A-Za-z0-9:_-]{1,80}$/;

/** Every rupiah amount in a notification: "Rp 25.003", "Rp25,003.00", "IDR 25003". */
export function parseAmounts(text) {
  const amounts = [];
  for (const [, digits] of String(text).matchAll(/(?:Rp\.?|IDR)\s*(\d[\d.,]*)/gi)) {
    // Two digits after the last separator are cents; three are a thousands group.
    const whole = digits.replace(/[.,]+$/, '').replace(/[.,]\d{2}$/, '').replace(/[.,]/g, '');
    const amount = Number(whole);
    if (Number.isSafeInteger(amount) && amount > 0) amounts.push(amount);
  }
  return amounts;
}

/** The charges and the notification log, with no HTTP: `save` is called after every change. */
export class QrisDesk {
  constructor(saved = {}, { now = Date.now, save = () => {} } = {}) {
    this.now = now;
    this.save = save;
    this.token = saved.token || randomBytes(24).toString('hex');
    this.charges = saved.charges || {};
    /** Every notification received, newest first: matched, unmatched, or ignored by staff. */
    this.log = saved.log || [];
    this.lastSeen = saved.lastSeen || null;
    /** When the phone last reached this computer at all: a notification or its regular "ping". */
    this.lastContact = saved.lastContact || null;
    this.recent = new Map();
    if (!saved.token) this.save(this.snapshot());
  }

  snapshot() {
    return { token: this.token, charges: this.charges, log: this.log, lastSeen: this.lastSeen, lastContact: this.lastContact };
  }

  purge() {
    const now = this.now();
    for (const [key, charge] of Object.entries(this.charges)) {
      if (charge.status === 'paid' ? now - charge.paidAt > KEEP_PAID_MS : now > charge.expiresAt + GRACE_MS) delete this.charges[key];
    }
  }

  waiting() {
    return Object.values(this.charges).filter((charge) => charge.status === 'pending');
  }

  /** Registers a charge and picks its total. Asking again for the same key returns the same one. */
  charge(key, amount, expiresInMs, always) {
    this.purge();
    if (this.charges[key]) return this.charges[key];
    const waiting = this.waiting();
    if (waiting.length >= MAX_WAITING) throw Object.assign(new Error('Too many payments are waiting.'), { status: 429 });
    const taken = new Set(waiting.map((charge) => charge.total));
    let code = always ? 1 : 0;
    while (code <= MAX_CODE && taken.has(amount + code)) code += 1;
    if (code > MAX_CODE) throw Object.assign(new Error('Too many payments of this amount are waiting. Try again in a minute.'), { status: 409 });
    const charge = { key, amount, code, total: amount + code, status: 'pending', createdAt: this.now(), expiresAt: this.now() + expiresInMs };
    this.charges[key] = charge;
    this.save(this.snapshot());
    return charge;
  }

  release(key) {
    if (this.charges[key]?.status !== 'pending') return;
    delete this.charges[key];
    this.save(this.snapshot());
  }

  paidSince(since) {
    this.purge();
    return Object.values(this.charges).filter((charge) => charge.status === 'paid' && charge.paidAt >= since).map((charge) => charge.key);
  }

  /** The phone's regular sign of life, so a frozen forwarding app shows before a customer pays. */
  ping() {
    this.lastContact = this.now();
    this.save(this.snapshot());
  }

  /** One forwarded notification. Settles the single waiting charge its amount names, if there is one. */
  ingest(text) {
    const now = this.now();
    this.purge();
    for (const [seen, at] of this.recent) if (now - at > REPEAT_MS) this.recent.delete(seen);
    if (this.recent.has(text)) return { matched: null, repeat: true };
    this.recent.set(text, now);
    this.lastSeen = now;
    this.lastContact = now;
    const amounts = parseAmounts(text);
    const hits = this.waiting().filter((charge) => amounts.includes(charge.total));
    const entry = { id: randomBytes(6).toString('hex'), at: now, text: text.slice(0, 300), amounts, status: 'unmatched' };
    if (hits.length === 1) this.settle(entry, hits[0], false);
    this.log.unshift(entry);
    this.log.length = Math.min(this.log.length, MAX_LOG);
    this.save(this.snapshot());
    return { matched: hits.length === 1 ? hits[0].key : null, repeat: false };
  }

  settle(entry, charge, byHand) {
    charge.status = 'paid';
    charge.paidAt = this.now();
    Object.assign(entry, { status: 'matched', key: charge.key, total: charge.total, byHand });
  }

  /** Staff settle a notification the amounts could not place: onto a waiting QR, or set aside. */
  resolve(id, action, key) {
    this.purge();
    const entry = this.log.find((item) => item.id === id);
    if (entry?.status !== 'unmatched') throw Object.assign(new Error('That notification is settled already.'), { status: 409 });
    if (action === 'match') {
      const charge = this.charges[key];
      if (charge?.status !== 'pending') throw Object.assign(new Error('That QR is no longer waiting.'), { status: 409 });
      this.settle(entry, charge, true);
    } else entry.status = 'ignored';
    this.save(this.snapshot());
  }

  /** A new secret: the old POST address stops working at once. */
  rotate() {
    this.token = randomBytes(24).toString('hex');
    this.save(this.snapshot());
  }
}

const loopback = (address = '') => address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.');

function localAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return '127.0.0.1';
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The readable text of a notification, whatever shape the forwarding app sends. */
function notificationText(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return Object.values(parsed).filter((value) => typeof value === 'string').join(' ');
  } catch { /* Plain text or a form body: use it as it came. */ }
  return raw;
}

function sameToken(given, token) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A request handler for /api/qris/..., keeping its state in `file`. Returns false for other paths. */
export function qrisHandler(file) {
  const desk = new QrisDesk(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}, {
    save(state) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    },
  });
  const send = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(payload));
  };

  async function handle(req, res, url) {
    const path = url.pathname.slice('/api/qris/'.length);
    if (path === 'charges' && req.method === 'POST') {
      const input = JSON.parse(await body(req));
      const amount = Number(input.amount);
      const expiresInMs = Number(input.expiresInMs);
      if (!KEY.test(input.key) || !Number.isSafeInteger(amount) || amount < 1 || !(expiresInMs >= 60_000 && expiresInMs <= 7_200_000)) return send(res, 400, { error: 'Invalid charge.' });
      const { key, code, total } = desk.charge(input.key, amount, expiresInMs, input.uniqueCode === 'always');
      return send(res, 200, { key, code, total });
    }
    if (path.startsWith('charges/') && req.method === 'DELETE') {
      desk.release(decodeURIComponent(path.slice('charges/'.length)));
      return send(res, 200, { ok: true });
    }
    if (path === 'paid' && req.method === 'GET') {
      // The device hands `now` back as its next `since`, so its own clock never matters.
      const now = Date.now();
      return send(res, 200, { paid: desk.paidSince(Number(url.searchParams.get('since')) || 0), now, lastContact: desk.lastContact });
    }
    if ((path === 'mutations' || path.startsWith('mutations/')) && req.method === 'POST') {
      const given = path.slice('mutations/'.length) || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!sameToken(given, desk.token)) return send(res, 401, { error: 'Wrong token.' });
      const text = notificationText(await body(req)).trim();
      if (!text) return send(res, 400, { error: 'Empty notification.' });
      if (/^ping$/i.test(text)) {
        desk.ping();
        return send(res, 200, { ok: true });
      }
      const { matched, repeat } = desk.ingest(text);
      return send(res, 200, { matched: Boolean(matched), repeat });
    }
    // Everything below manages the money trail, so only the booth computer itself may ask.
    if (path === 'setup' || path === 'token' || path.startsWith('log/')) {
      if (!loopback(req.socket.remoteAddress)) return send(res, 403, { error: 'Open this page on the booth computer to manage QRIS notifications.' });
      if (path === 'setup' && req.method === 'GET') {
        desk.purge();
        return send(res, 200, { token: desk.token, origin: `http://${localAddress()}:${req.socket.localPort}`, lastSeen: desk.lastSeen, lastContact: desk.lastContact, waiting: desk.waiting(), log: desk.log });
      }
      if (path === 'token' && req.method === 'POST') {
        desk.rotate();
        return send(res, 200, { ok: true });
      }
      if (path.startsWith('log/') && req.method === 'POST') {
        const input = JSON.parse(await body(req));
        desk.resolve(path.slice('log/'.length), input.action === 'match' ? 'match' : 'ignore', String(input.key || ''));
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { error: 'Not found.' });
  }

  return (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/qris/')) return false;
    handle(req, res, url).catch((error) => send(res, error.status || 400, { error: error.message }));
    return true;
  };
}
