import { describe, expect, it } from 'vitest';
import { busyHours, change, compareRange, dailySeries, daysBetween, discountReport, matchesFilter, NO_FILTER, previousRange, staffReport, takenByMethod, totals } from './insights';
import type { ActivityEntry, Order, PaymentMethod, Refund, Voucher } from './model';

const ZONE = 'Asia/Jakarta';
/** 2026-11-21 is a Saturday; 07:00 UTC is 14:00 in Jakarta. */
const SAT_2PM = Date.UTC(2026, 10, 21, 7, 15);

function order(id: string, overrides: Partial<Order> = {}, paid: [PaymentMethod, number][] = [['cash', 35_000]]): Order {
  return {
    id,
    number: `INV-${id}`,
    channel: 'cashier',
    branchId: 'b',
    boothId: null,
    staffId: 'kasir',
    shiftId: null,
    lines: [{ id: `${id}-l1`, kind: 'session', refId: 'photobox', label: 'Photo strip', unitPrice: 35_000, qty: 1, discount: 0, refunded: false }],
    presetId: null,
    voucherCode: null,
    subtotal: 35_000,
    discount: 0,
    total: 35_000,
    payments: paid.map(([method, amount], index) => ({ id: `${id}-p${index}`, method, amount, status: 'paid', reference: '', createdAt: SAT_2PM })) as Order['payments'],
    status: 'paid',
    sessionVouchers: [],
    ticketNumbers: [],
    customerEmail: '',
    createdAt: SAT_2PM,
    paidAt: SAT_2PM,
    ...overrides,
  } as Order;
}

const refund = (orderId: string, amount: number, staffId = 'kasir', supervisorId = 'sari'): Refund => ({ id: `r-${orderId}`, orderId, lineId: `${orderId}-l1`, amount, reason: 'Cetakan gelap', staffId, supervisorId, method: 'cash', at: SAT_2PM });

describe('totals', () => {
  it('counts paid orders, refunds on them, sessions and prints', () => {
    const withPrint = order('b', { lines: [...order('x').lines, { id: 'b-l2', kind: 'print', refId: '4R', label: '4R', unitPrice: 15_000, qty: 2, discount: 0, refunded: false }], discount: 5_000 }, [['qris', 60_000]]);
    const result = totals([order('a'), withPrint, order('c', { status: 'void' })], [refund('a', 35_000), refund('elsewhere', 10_000)]);
    expect(result).toEqual({ orders: 2, gross: 95_000, refunds: 35_000, net: 60_000, average: 30_000, discount: 5_000, sessions: 2, prints: 2 });
    expect(totals([], [])).toMatchObject({ orders: 0, average: 0 });
  });

  it('compares with the period just as long before it', () => {
    expect(previousRange('2026-11-15', '2026-11-21')).toEqual({ from: '2026-11-08', to: '2026-11-14' });
    expect(previousRange('2026-03-01', '2026-03-01')).toEqual({ from: '2026-02-28', to: '2026-02-28' });
    expect(daysBetween('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(change(150, 100)).toBe(50);
    expect(change(80, 100)).toBe(-20);
    expect(change(80, 0)).toBeNull();
  });
});

describe('comparing and filtering', () => {
  it('compares with the period before or the same dates a year earlier', () => {
    expect(compareRange('2026-11-01', '2026-11-30', 'previous')).toEqual({ from: '2026-10-02', to: '2026-10-31' });
    expect(compareRange('2026-11-01', '2026-11-30', 'year')).toEqual({ from: '2025-11-01', to: '2025-11-30' });
    expect(compareRange('2028-02-29', '2028-02-29', 'year')).toEqual({ from: '2027-02-28', to: '2027-02-28' });
    expect(compareRange('2026-11-01', '2026-11-30', 'none')).toBeNull();
  });

  it('keeps the orders a filter names, the till counting as its own booth', () => {
    const till = order('a');
    const booth = order('b', { channel: 'booth', boothId: 'saung', staffId: null, branchId: 'lembang' });
    expect(matchesFilter(till, NO_FILTER) && matchesFilter(booth, NO_FILTER)).toBe(true);
    expect([till, booth].filter((entry) => matchesFilter(entry, { ...NO_FILTER, boothId: 'cashier' }))).toEqual([till]);
    expect([till, booth].filter((entry) => matchesFilter(entry, { ...NO_FILTER, channel: 'booth', branchId: 'lembang' }))).toEqual([booth]);
    expect([till, booth].filter((entry) => matchesFilter(entry, { ...NO_FILTER, staffId: 'kasir' }))).toEqual([till]);
  });

  it('puts each day of a chart in its own slot, net of refunds', () => {
    const days = ['2026-11-20', '2026-11-21', '2026-11-22'];
    const orders = [order('a'), order('b'), order('c', { paidAt: SAT_2PM + 86_400_000 }), order('d', { status: 'void' })];
    expect(dailySeries(orders, [refund('a', 35_000)], days, ZONE, 'net')).toEqual([0, 35_000, 35_000]);
    expect(dailySeries(orders, [], days, ZONE, 'orders')).toEqual([0, 2, 1]);
    expect(dailySeries(orders, [], days, ZONE, 'sessions')).toEqual([0, 2, 1]);
  });
});

describe('busyHours', () => {
  it('puts each paid order in its weekday and hour, in the venue time zone', () => {
    const later = SAT_2PM + 30 * 60_000;
    const grid = busyHours([order('a'), order('b', { paidAt: later }), order('c', { paidAt: SAT_2PM + 86_400_000 }), order('d', { status: 'open' })], ZONE);
    expect(grid.orders[6][14]).toBe(2);
    expect(grid.revenue[6][14]).toBe(70_000);
    expect(grid.orders[0][14]).toBe(1);
    expect(grid.peak).toEqual({ weekday: 6, hour: 14, orders: 2 });
    expect(busyHours([], ZONE).peak).toBeNull();
  });
});

describe('staffReport', () => {
  it('credits sales, refunds, approvals and cancellations to the right person', () => {
    const voids: ActivityEntry[] = [{ id: 'v1', at: SAT_2PM, kind: 'order.void', message: 'Membatalkan INV-9.', staffId: 'kasir', branchId: 'b' }];
    const rows = staffReport([order('a'), order('b'), order('k', { staffId: null, channel: 'booth' })], [refund('a', 35_000)], voids);
    expect(rows.find((row) => row.staffId === 'kasir')).toMatchObject({ orders: 2, gross: 70_000, refunds: 1, refunded: 35_000, voids: 1, approved: 0 });
    expect(rows.find((row) => row.staffId === 'sari')).toMatchObject({ orders: 0, approved: 1 });
    expect(rows.find((row) => row.staffId === null)).toMatchObject({ orders: 1, gross: 35_000 });
  });
});

describe('discountReport', () => {
  it('groups by voucher and preset, and puts receipt codes in one row', () => {
    const vouchers = [{ code: 'STRUK1', orderId: 'paid-earlier' }, { code: 'PELAJAR' }] as Voucher[];
    const rows = discountReport(
      [
        order('a', { voucherCode: 'PELAJAR', discount: 3_500 }, [['cash', 31_500]]),
        order('b', { voucherCode: 'PELAJAR', presetId: 'p1', discount: 3_500 }, [['cash', 31_500]]),
        order('c', { presetId: 'p1', discount: 5_000 }, [['cash', 30_000]]),
        order('d', { voucherCode: 'STRUK1', discount: 35_000, channel: 'booth' }, []),
        order('e'),
      ],
      vouchers,
      [{ id: 'p1', name: 'Rombongan', kind: 'amount', value: 5_000 }],
    );
    expect(rows.map((row) => [row.kind, row.name, row.orders, row.discount, row.revenue])).toEqual([
      ['receipt', null, 1, 35_000, 0],
      ['voucher', 'PELAJAR', 2, 7_000, 63_000],
      ['preset', 'Rombongan', 1, 5_000, 30_000],
    ]);
  });
});

describe('takenByMethod', () => {
  it('adds up paid payments per method', () => {
    expect(takenByMethod([order('a'), order('b', {}, [['cash', 20_000], ['qris', 15_000]]), order('c', { status: 'void' })])).toEqual({ cash: 55_000, qris: 15_000, card: 0, ewallet: 0 });
  });
});
