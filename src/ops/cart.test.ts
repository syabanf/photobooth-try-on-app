import { describe, expect, it } from 'vitest';
import { amountDue, changeFor, formatRupiah, orderNumber, priceLines, refundMethod, spread } from './cart';
import type { Order, OrderLine, Refund, Shift, Voucher } from './model';
import { shiftSlip } from './shift';

const line = (id: string, kind: OrderLine['kind'], unitPrice: number, qty = 1): OrderLine => ({
  id,
  kind,
  label: id,
  refId: id,
  unitPrice,
  qty,
  discount: 0,
  refunded: false,
});

const voucher: Voucher = {
  id: 'v',
  code: 'HALF',
  kind: 'percent',
  value: 50,
  scope: 'multi',
  boothIds: [],
  maxUses: 10,
  uses: 0,
  validFrom: '',
  validTo: '',
  happyHour: null,
  frameIds: [],
  eventMode: false,
  active: true,
  createdAt: 0,
};

describe('spread', () => {
  it('splits a discount so the parts add up exactly', () => {
    const parts = spread(10_000, [35_000, 35_000, 30_000]);
    expect(parts.reduce((a, b) => a + b)).toBe(10_000);
    expect(spread(1, [1, 1, 1]).reduce((a, b) => a + b)).toBe(1);
    expect(spread(500, [0, 0])).toEqual([0, 0]);
  });
});

describe('priceLines', () => {
  const lines = [line('session', 'session', 35_000), line('print', 'print', 10_000, 2), line('mug', 'merch', 45_000)];

  it('totals without discounts', () => {
    expect(priceLines(lines, null, null)).toMatchObject({ subtotal: 100_000, discount: 0, total: 100_000 });
  });

  it('applies the voucher to session lines only', () => {
    const priced = priceLines(lines, null, voucher);
    expect(priced.discount).toBe(17_500);
    expect(priced.lines.map((l) => l.discount)).toEqual([17_500, 0, 0]);
    expect(priced.total).toBe(82_500);
  });

  it('applies a preset to the whole order, then the voucher to what is left of the session', () => {
    const priced = priceLines(lines, { id: 'p', name: 'Staff', kind: 'percent', value: 10 }, voucher);
    // 10% of 100,000 = 10,000; session left 31,500; half = 15,750.
    expect(priced.discount).toBe(25_750);
    expect(priced.total).toBe(74_250);
    expect(priced.lines.reduce((sum, l) => sum + l.discount, 0)).toBe(25_750);
  });

  it('never discounts below zero', () => {
    expect(priceLines(lines, { id: 'p', name: 'Big', kind: 'amount', value: 500_000 }, null).total).toBe(0);
  });
});

describe('payments', () => {
  it('works out what is due and the change', () => {
    const order = { total: 82_500, payments: [{ id: 'p', method: 'cash' as const, amount: 50_000, status: 'paid' as const, reference: '', createdAt: 0 }] };
    expect(amountDue(order)).toBe(32_500);
    expect(changeFor(50_000, 32_500)).toBe(17_500);
    expect(changeFor(20_000, 32_500)).toBe(0);
  });

  it('formats rupiah the Indonesian way', () => {
    expect(formatRupiah(1_250_000)).toBe('Rp1.250.000');
    expect(formatRupiah(-2_500)).toBe('−Rp2.500');
  });

  it('numbers orders by day', () => {
    expect(orderNumber('INV', '2026-10-19', 7)).toBe('INV-261019-0007');
  });
});

describe('shiftSlip', () => {
  const shift: Shift = { id: 's1', branchId: 'b', staffId: 'u1', openedAt: 0, openingCash: 200_000, countedCash: 255_000, closedAt: 100 };
  const order = (id: string, method: 'cash' | 'qris', amount: number): Order => ({
    id,
    number: id,
    channel: 'cashier',
    branchId: 'b',
    boothId: null,
    staffId: 'u1',
    shiftId: 's1',
    lines: [],
    presetId: null,
    voucherCode: null,
    subtotal: amount,
    discount: 0,
    total: amount,
    payments: [{ id: `${id}p`, method, amount, status: 'paid', reference: '', createdAt: 1 }],
    status: 'paid',
    sessionVouchers: [],
    ticketNumbers: [],
    customerEmail: '',
    createdAt: 1,
  });
  const orders = [order('o1', 'cash', 70_000), order('o2', 'qris', 35_000), { ...order('o3', 'cash', 99_000), shiftId: 'other' }];
  const refunds: Refund[] = [{ id: 'r', orderId: 'o1', lineId: 'l', amount: 10_000, reason: 'Blurry', staffId: 'u1', supervisorId: 'sup', method: 'cash', at: 50 }];

  it('adds up methods, refunds and the drawer', () => {
    const slip = shiftSlip(shift, orders, refunds);
    expect(slip).toMatchObject({ orders: 2, gross: 105_000, refunds: 10_000, net: 95_000, expectedCash: 260_000, countedCash: 255_000, variance: -5_000 });
    expect(slip.byMethod).toEqual({ cash: 70_000, qris: 35_000, card: 0, ewallet: 0 });
  });

  it('refunds through cash when the order took cash', () => {
    expect(refundMethod(orders[0])).toBe('cash');
    expect(refundMethod(orders[1])).toBe('qris');
  });
});
