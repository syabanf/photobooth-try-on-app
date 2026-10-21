import { describe, expect, it } from 'vitest';
import { approves, can, checkPin, findApprover, hashPin, seesBranch } from './access';
import { bucket, compareVersions, sessionsToPurge, targetVersion, DAY_MS } from './fleet';
import type { BoothSession, Order, Payment, Release, Staff } from './model';
import { bestSellers, parseGatewayCsv, reconcileSettlement, revenueReport, toCsv } from './reports';

describe('access', () => {
  it('gives each role its permissions', () => {
    expect(can({ role: 'cashier' }, 'pos.sell')).toBe(true);
    expect(can({ role: 'cashier' }, 'pos.refund')).toBe(false);
    expect(can({ role: 'operator' }, 'booth.run')).toBe(true);
    expect(can({ role: 'admin' }, 'staff.manage')).toBe(false);
    expect(can(null, 'pos.sell')).toBe(false);
    expect(approves({ role: 'supervisor', active: true })).toBe(true);
    expect(approves({ role: 'supervisor', active: false })).toBe(false);
  });

  it('scopes staff to their branches', () => {
    expect(seesBranch({ branchIds: [] }, 'mall')).toBe(true);
    expect(seesBranch({ branchIds: ['mall'] }, 'mall')).toBe(true);
    expect(seesBranch({ branchIds: ['mall'] }, 'airport')).toBe(false);
  });

  it('hashes PINs and finds the supervisor who typed theirs', async () => {
    const pin = await hashPin('2468');
    const sup = { id: 's', name: 'Sari', role: 'supervisor', branchIds: [], email: '', phone: '', onDuty: true, active: true, ...pin } as Staff;
    const cashier = { ...sup, id: 'c', role: 'cashier' } as Staff;
    expect(await checkPin(sup, '2468')).toBe(true);
    expect(await checkPin(sup, '1357')).toBe(false);
    expect((await findApprover([cashier, sup], '2468'))?.id).toBe('s');
    await expect(hashPin('12')).rejects.toThrow('4 to 8 digits');
  });
});

describe('fleet', () => {
  const release = (id: string, version: string, percent: number, status: Release['status'] = 'staged'): Release => ({ id, version, notes: '', percent, status, createdAt: 0 });

  it('buckets booths stably', () => {
    expect(bucket('booth-1', 'r1')).toBe(bucket('booth-1', 'r1'));
    const spread = new Set(Array.from({ length: 200 }, (_, i) => bucket(`b${i}`, 'r')));
    expect(spread.size).toBeGreaterThan(50);
  });

  it('stages, widens and rolls back', () => {
    const booths = Array.from({ length: 400 }, (_, i) => `booth-${i}`);
    const share = (releases: Release[], version: string) => booths.filter((b) => targetVersion(releases, b, '1.0.0') === version).length / booths.length;
    expect(share([release('r2', '1.1.0', 10)], '1.1.0')).toBeGreaterThan(0.04);
    expect(share([release('r2', '1.1.0', 10)], '1.1.0')).toBeLessThan(0.18);
    expect(share([release('r2', '1.1.0', 100)], '1.1.0')).toBe(1);
    expect(share([release('r1', '1.0.5', 100), release('r2', '1.1.0', 100, 'rolled-back')], '1.0.5')).toBe(1);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });

  it('purges sessions past the retention window once', () => {
    const session = (id: string, ended: number, purgedAt?: number) => ({ id, startedAt: ended, endedAt: ended, purgedAt }) as BoothSession;
    const now = 100 * DAY_MS;
    const sessions = [session('old', 50 * DAY_MS), session('new', 95 * DAY_MS), session('gone', 10 * DAY_MS, 60 * DAY_MS)];
    expect(sessionsToPurge(sessions, 30, now).map((s) => s.id)).toEqual(['old']);
    expect(sessionsToPurge(sessions, 0, now)).toEqual([]);
  });
});

describe('reports', () => {
  const pay = (method: Payment['method'], amount: number, reference = ''): Payment => ({ id: reference || method, method, amount, status: 'paid', reference, createdAt: 0 });
  const order = (id: string, boothId: string | null, paidAt: number, payments: Payment[]): Order => ({
    id,
    number: id,
    channel: 'cashier',
    branchId: 'mall',
    boothId,
    staffId: null,
    shiftId: 'sh1',
    lines: [{ id: `${id}l`, kind: 'session', label: 'Photo strip', refId: 'c', unitPrice: 35_000, qty: 1, discount: 0, refunded: false }],
    presetId: null,
    voucherCode: null,
    subtotal: 35_000,
    discount: 0,
    total: 35_000,
    payments,
    status: 'paid',
    sessionVouchers: [],
    ticketNumbers: [],
    customerEmail: '',
    createdAt: paidAt,
    paidAt,
  });
  const orders = [
    order('o1', 'b1', Date.UTC(2026, 9, 18, 3), [pay('cash', 35_000)]),
    order('o2', 'b1', Date.UTC(2026, 9, 19, 3), [pay('qris', 35_000, 'Q-1')]),
    order('o3', 'b2', Date.UTC(2026, 9, 19, 20), [pay('qris', 35_000, 'Q-2')]),
  ];
  const input = {
    orders,
    refunds: [{ id: 'r', orderId: 'o1', lineId: 'o1l', amount: 5_000, reason: '', staffId: null, supervisorId: 's', method: 'cash' as const, at: 0 }],
    sessions: [],
    timeZone: 'Asia/Jakarta',
    label: (_: string, key: string) => key.toUpperCase(),
  };

  it('groups revenue by booth and by local day', () => {
    expect(revenueReport(input, 'booth').map((r) => [r.key, r.orders, r.gross, r.refunds, r.net])).toEqual([
      ['b1', 2, 70_000, 5_000, 65_000],
      ['b2', 1, 35_000, 0, 35_000],
    ]);
    // 19 Oct 20:00 UTC is already 20 Oct in Jakarta.
    expect(revenueReport(input, 'day').map((r) => r.key)).toEqual(['2026-10-20', '2026-10-19', '2026-10-18']);
  });

  it('writes CSV that survives commas and quotes', () => {
    expect(toCsv(['Name', 'Total'], [['Kiosk "1", Mall', 35_000]])).toBe('Name,Total\r\n"Kiosk ""1"", Mall",35000');
  });

  it('ranks best sellers', () => {
    expect(bestSellers(orders)[0]).toEqual({ label: 'Photo strip', qty: 3, revenue: 105_000 });
  });

  it('reconciles a gateway export with the ledger', () => {
    const csv = 'order_id,gross_amount,transaction_status,fee\nQ-1,35000,settlement,245\nQ-2,30000,settlement,210\nQ-9,10000,settlement,70\nQ-3,5000,expire,0';
    const rows = parseGatewayCsv(csv);
    expect(rows).toHaveLength(4);
    const result = reconcileSettlement(orders.flatMap((o) => o.payments), rows);
    expect(result.matched.map((m) => m.reference)).toEqual(['Q-1']);
    expect(result.mismatched).toEqual([{ reference: 'Q-2', ledger: 35_000, gateway: 30_000 }]);
    expect(result.missingInLedger.map((r) => r.reference)).toEqual(['Q-9']);
    expect(result.missingInGateway).toEqual([]);
    expect(result).toMatchObject({ ledgerTotal: 70_000, gatewayTotal: 75_000, fees: 525 });
  });

  it('refuses a file without the columns it needs', () => {
    expect(() => parseGatewayCsv('a,b\n1,2')).toThrow('reference and an amount');
  });
});
