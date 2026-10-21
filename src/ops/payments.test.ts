import { describe, expect, it } from 'vitest';
import type { Order, Payment } from './model';
import { DEFAULT_PAYMENTS, allowedMethods, feeFor, gatewayLabel, isExpired, methodAllowed, paymentReport, paymentRows, summarizePayments, withPaymentDefaults } from './payments';

const pay = (over: Partial<Payment>): Payment => ({ id: 'p', method: 'cash', amount: 35_000, status: 'paid', reference: '', createdAt: 1, ...over });
const order = (id: string, channel: Order['channel'], payments: Payment[], branchId = 'mall'): Order => ({
  id,
  number: `INV-${id}`,
  channel,
  branchId,
  boothId: null,
  staffId: null,
  shiftId: null,
  lines: [],
  presetId: null,
  voucherCode: null,
  subtotal: 0,
  discount: 0,
  total: 0,
  payments,
  status: 'paid',
  sessionVouchers: [],
  ticketNumbers: [],
  customerEmail: '',
  createdAt: 1,
});

describe('method rules', () => {
  it('offers each method only where it is switched on', () => {
    expect(allowedMethods(DEFAULT_PAYMENTS, 'cashier')).toEqual(['cash', 'qris', 'card', 'ewallet']);
    expect(allowedMethods(DEFAULT_PAYMENTS, 'booth')).toEqual(['qris']);
    const off = withPaymentDefaults({ methods: { qris: { enabled: false } } as never });
    expect(methodAllowed(off, 'qris', 'booth')).toBe(false);
    expect(methodAllowed(off, 'card', 'cashier')).toBe(true);
  });

  it('rounds the fee to whole rupiah', () => {
    expect(feeFor(DEFAULT_PAYMENTS, 'qris', 35_000)).toBe(245);
    expect(feeFor(DEFAULT_PAYMENTS, 'cash', 35_000)).toBe(0);
  });

  it('fills saved settings in and keeps the old provider field', () => {
    const settings = withPaymentDefaults(undefined, 'xendit');
    expect(settings.gateway.provider).toBe('xendit');
    expect(settings.wallets).toEqual(DEFAULT_PAYMENTS.wallets);
    expect(gatewayLabel(settings)).toBe('Xendit sandbox');
    expect(gatewayLabel({ ...settings, gateway: { ...settings.gateway, mode: 'production' } })).toBe('Xendit');
  });

  it('knows when a QR ran out', () => {
    const qr = pay({ status: 'pending', expiresAt: 100 });
    expect(isExpired(qr, 99)).toBe(false);
    expect(isExpired(qr, 100)).toBe(true);
    expect(isExpired({ ...qr, status: 'paid' }, 200)).toBe(false);
  });
});

describe('payment list', () => {
  const orders = [
    order('1', 'cashier', [pay({ id: 'a', method: 'cash', createdAt: 1 })]),
    order('2', 'booth', [pay({ id: 'b', method: 'qris', status: 'expired', createdAt: 2, reference: 'BTH-2-1' }), pay({ id: 'c', method: 'qris', fee: 245, createdAt: 3, reference: 'BTH-2-2' })]),
    order('3', 'cashier', [pay({ id: 'd', method: 'ewallet', wallet: 'GoPay', fee: 525, createdAt: 4 }), pay({ id: 'e', method: 'qris', status: 'pending', amount: 10_000, createdAt: 5 })], 'airport'),
  ];

  it('lists newest first and filters by status, method, channel, branch and text', () => {
    expect(paymentRows(orders).map((row) => row.payment.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(paymentRows(orders, { status: 'expired' }).map((row) => row.payment.id)).toEqual(['b']);
    expect(paymentRows(orders, { method: 'qris', channel: 'booth' }).map((row) => row.payment.id)).toEqual(['c', 'b']);
    expect(paymentRows(orders, { branchId: 'airport' }).map((row) => row.payment.id)).toEqual(['e', 'd']);
    expect(paymentRows(orders, { query: 'gopay' }).map((row) => row.payment.id)).toEqual(['d']);
    expect(paymentRows(orders, { query: 'bth-2-1' }).map((row) => row.payment.id)).toEqual(['b']);
  });

  it('sums what was paid, the fees, refunds and what is still waiting', () => {
    const summary = summarizePayments(paymentRows(orders), [{ id: 'r', orderId: '1', lineId: 'l', amount: 5_000, reason: '', staffId: null, supervisorId: 's', method: 'cash', at: 9 }]);
    expect(summary).toMatchObject({ paid: 105_000, fees: 770, refunded: 5_000, net: 99_230, pending: 1, pendingAmount: 10_000 });
    expect(summary.byMethod.qris).toEqual({ count: 1, amount: 35_000, fees: 245 });
  });
});

describe('payment report', () => {
  const orders = [
    order('1', 'cashier', [pay({ id: 'a', method: 'cash', amount: 50_000, paidAt: 10 })]),
    order('2', 'booth', [pay({ id: 'b', method: 'qris', status: 'expired' }), pay({ id: 'c', method: 'qris', amount: 35_000, fee: 245, paidAt: 20 })]),
    order('3', 'cashier', [pay({ id: 'd', method: 'ewallet', amount: 30_000, fee: 450, paidAt: 30 })], 'airport'),
  ];
  const refunds = [{ id: 'r', orderId: '1', lineId: 'l', amount: 10_000, reason: '', staffId: null, supervisorId: 's', method: 'cash' as const, at: 40 }];
  const input = { orders, refunds, dayOf: (time: number) => (time < 25 ? 'day-1' : 'day-2'), label: (_: string, key: string) => key.toUpperCase() };

  it('groups by method with fees and refunds, best net first', () => {
    expect(paymentReport(input, 'method').map((row) => [row.key, row.count, row.gross, row.fees, row.refunds, row.net])).toEqual([
      ['cash', 1, 50_000, 0, 10_000, 40_000],
      ['qris', 1, 35_000, 245, 0, 34_755],
      ['ewallet', 1, 30_000, 450, 0, 29_550],
    ]);
  });

  it('groups by day, newest first, with the refund on the day it was given', () => {
    expect(paymentReport(input, 'day').map((row) => [row.key, row.gross, row.refunds])).toEqual([
      ['day-2', 30_000, 10_000],
      ['day-1', 85_000, 0],
    ]);
  });

  it('groups by branch and booth, skipping payments that never went through', () => {
    expect(paymentReport(input, 'branch').map((row) => [row.key, row.count, row.net])).toEqual([
      ['mall', 2, 74_755],
      ['airport', 1, 29_550],
    ]);
    expect(paymentReport(input, 'booth').map((row) => row.key)).toEqual(['cashier']);
  });
});
