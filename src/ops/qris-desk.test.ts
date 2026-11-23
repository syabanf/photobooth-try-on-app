import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain Node module shared with scripts/serve.mjs, with no type declarations.
import { parseAmounts, QrisDesk } from '../../scripts/qris-mutations.mjs';

const MINUTES = 60_000;

function desk() {
  const clock = { at: 1_000_000 };
  return { clock, desk: new QrisDesk({ token: 'secret' }, { now: () => clock.at }) };
}

describe('parseAmounts', () => {
  it('reads rupiah in the ways banks and wallets write it', () => {
    expect(parseAmounts('Pembayaran QRIS Rp 35.003 diterima dari BUDI')).toEqual([35_003]);
    expect(parseAmounts('Dana masuk Rp25,003.00 ke rekening')).toEqual([25_003]);
    expect(parseAmounts('Kamu menerima Rp1.250.000,00.')).toEqual([1_250_000]);
    expect(parseAmounts('Transfer IDR 20000 berhasil. Saldo Rp 1.020.000')).toEqual([20_000, 1_020_000]);
    expect(parseAmounts('Promo akhir tahun, diskon 50%')).toEqual([]);
  });
});

describe('QrisDesk', () => {
  it('gives each waiting charge its own total', () => {
    const { desk: d } = desk();
    expect(d.charge('a:1', 35_000, 15 * MINUTES, false)).toMatchObject({ code: 0, total: 35_000 });
    expect(d.charge('b:1', 35_000, 15 * MINUTES, false)).toMatchObject({ code: 1, total: 35_001 });
    expect(d.charge('c:1', 35_000, 15 * MINUTES, true)).toMatchObject({ code: 2, total: 35_002 });
    expect(d.charge('d:1', 20_000, 15 * MINUTES, true)).toMatchObject({ code: 1, total: 20_001 });
  });

  it('keeps one device from taking every waiting slot', () => {
    const { desk: d } = desk();
    for (let n = 0; n < 30; n += 1) d.charge(`a:${n}`, 10_000, 15 * MINUTES, false, '192.168.1.20');
    expect(() => d.charge('a:30', 10_000, 15 * MINUTES, false, '192.168.1.20')).toThrow('too many payments waiting');
    expect(d.charge('b:1', 10_000, 15 * MINUTES, false, '192.168.1.21').total).toBe(10_030);
  });

  it('returns the same charge when asked twice', () => {
    const { desk: d } = desk();
    const first = d.charge('a:1', 35_000, 15 * MINUTES, true);
    expect(d.charge('a:1', 35_000, 15 * MINUTES, true)).toBe(first);
    expect(d.waiting()).toHaveLength(1);
  });

  it('settles the one charge a notification names, once', () => {
    const { desk: d, clock } = desk();
    d.charge('a:1', 35_000, 15 * MINUTES, false);
    d.charge('b:1', 35_000, 15 * MINUTES, false);
    expect(d.ingest('QRIS Rp 35.001 diterima')).toEqual({ matched: 'b:1', repeat: false });
    expect(d.ingest('QRIS Rp 35.001 diterima')).toEqual({ matched: null, repeat: true });
    clock.at += 2 * MINUTES;
    // The same text later is a new notification, and nothing waits for that amount now.
    expect(d.ingest('QRIS Rp 35.001 diterima').matched).toBeNull();
    expect(d.paidSince(0)).toEqual(['b:1']);
    expect(d.log.map((entry: { status: string }) => entry.status)).toEqual(['unmatched', 'matched']);
  });

  it('logs a notification that matches nothing', () => {
    const { desk: d } = desk();
    d.charge('a:1', 35_000, 15 * MINUTES, false);
    expect(d.ingest('Dana masuk Rp 34.000').matched).toBeNull();
    expect(d.log[0]).toMatchObject({ amounts: [34_000], status: 'unmatched' });
    expect(d.lastSeen).toBe(1_000_000);
  });

  it('frees an amount when its QR is released or runs out', () => {
    const { desk: d, clock } = desk();
    d.charge('a:1', 35_000, 15 * MINUTES, false);
    d.release('a:1');
    expect(d.charge('b:1', 35_000, 15 * MINUTES, false).total).toBe(35_000);
    // Two minutes of grace after the QR's time, then the amount is free again.
    clock.at += 16 * MINUTES;
    expect(d.ingest('QRIS Rp 35.000 diterima').matched).toBe('b:1');
    d.charge('c:1', 50_000, 15 * MINUTES, false);
    clock.at += 18 * MINUTES;
    expect(d.ingest('QRIS Rp 50.000 diterima').matched).toBeNull();
  });

  it('lets staff place or set aside a notification that matched nothing', () => {
    const { desk: d } = desk();
    d.charge('a:1', 35_000, 15 * MINUTES, false);
    d.ingest('Dana masuk Rp 34.000');
    d.ingest('Promo cashback Rp 5.000');
    const [promo, short] = d.log;
    d.resolve(short.id, 'match', 'a:1');
    expect(d.log[1]).toMatchObject({ status: 'matched', key: 'a:1', total: 35_000, byHand: true });
    expect(d.paidSince(0)).toEqual(['a:1']);
    d.resolve(promo.id, 'ignore');
    expect(d.log[0].status).toBe('ignored');
    expect(() => d.resolve(short.id, 'ignore')).toThrow('settled already');
    expect(() => d.resolve('nope', 'ignore')).toThrow('settled already');
  });

  it('counts a ping as a sign of life without logging it', () => {
    const { desk: d, clock } = desk();
    expect(d.lastContact).toBeNull();
    d.ping();
    clock.at += MINUTES;
    d.ingest('Rp 1.000 masuk');
    expect(d.lastContact).toBe(clock.at);
    expect(d.log).toHaveLength(1);
  });

  it('stops the old address when the token is renewed', () => {
    const { desk: d } = desk();
    d.rotate();
    expect(d.token).not.toBe('secret');
    expect(d.token).toHaveLength(48);
  });

  it('reports only what was paid since the last ask', () => {
    const { desk: d, clock } = desk();
    d.charge('a:1', 10_000, 15 * MINUTES, false);
    d.ingest('Rp 10.000 masuk');
    clock.at += 5_000;
    expect(d.paidSince(clock.at)).toEqual([]);
    expect(d.paidSince(clock.at - 5_000)).toEqual(['a:1']);
  });
});
