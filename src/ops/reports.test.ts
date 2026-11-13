import { describe, expect, it } from 'vitest';
import type { FaceRecord, Order, OrderLine, Refund, Ticket } from './model';
import { floorReport, PRODUCT_LABELS, revenueReport } from './reports';

const ZONE = 'Asia/Jakarta';
const at = (hour: number, minute = 0) => Date.UTC(2026, 10, 13, hour - 7, minute);

const line = (id: string, kind: OrderLine['kind'], unitPrice: number, qty = 1): OrderLine => ({ id, kind, label: kind, refId: kind, unitPrice, qty, discount: 0 }) as OrderLine;
const order = (id: string, lines: OrderLine[], status: Order['status'] = 'paid'): Order =>
  ({ id, number: id, channel: 'booth', branchId: 'mall', boothId: 'b1', staffId: null, shiftId: null, lines, presetId: null, voucherCode: null, total: lines.reduce((sum, entry) => sum + entry.unitPrice * entry.qty, 0), payments: [{ id: `${id}-p`, method: 'qris', amount: lines.reduce((sum, entry) => sum + entry.unitPrice * entry.qty, 0), status: 'paid', reference: id, createdAt: at(10) }], status, createdAt: at(10), paidAt: at(10) }) as unknown as Order;

describe('revenue by product', () => {
  it('splits each order into what it sold and puts refunds on the line given back', () => {
    const orders = [
      order('o1', [line('l1', 'session', 35_000), line('l2', 'print', 15_000, 2)]),
      order('o2', [line('l3', 'preset', 25_000)]),
      order('o3', [line('l4', 'preset', 25_000)], 'void'),
    ];
    const refunds = [{ id: 'r1', orderId: 'o1', lineId: 'l2', amount: 15_000 } as Refund];
    const rows = revenueReport({ orders, refunds, sessions: [], timeZone: ZONE, label: (_group, key) => PRODUCT_LABELS[key as OrderLine['kind']] }, 'product');
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byKey.session).toMatchObject({ label: 'Photo sessions', orders: 1, sessions: 1, gross: 35_000, net: 35_000 });
    expect(byKey.print).toMatchObject({ orders: 1, gross: 30_000, refunds: 15_000, net: 15_000 });
    expect(byKey.preset).toMatchObject({ label: 'AI presets', orders: 1, gross: 25_000 });
  });
});

describe('floorReport', () => {
  it('counts the queue, the wait, the parties the gate photographed and the AI prints they bought', () => {
    const ticket = (id: string, created: number, status: Ticket['status'], calledAt?: number) => ({ id, status, createdAt: created, calledAt }) as Ticket;
    const tickets = [ticket('t1', at(10), 'done', at(10, 12)), ticket('t2', at(10, 30), 'skipped', at(10, 38)), ticket('t3', at(14), 'waiting')];
    const faces = [{ id: 'f1', ticketId: 't1' }, { id: 'f2', ticketId: 't1' }, { id: 'f3', ticketId: null }] as FaceRecord[];
    const report = floorReport({ tickets, faces, orders: [order('o1', [line('l1', 'preset', 25_000, 2)])], timeZone: ZONE });
    expect(report).toMatchObject({ tickets: 3, served: 1, skipped: 1, averageWait: 10, partiesPhotographed: 1, faces: 3, presetPrints: 2, presetRevenue: 50_000 });
    expect(report.byHour[10]).toBe(2);
    expect(report.byHour[14]).toBe(1);
  });

  it('has no average wait before anyone is called', () => {
    expect(floorReport({ tickets: [], faces: [], orders: [], timeZone: ZONE }).averageWait).toBeNull();
  });
});
