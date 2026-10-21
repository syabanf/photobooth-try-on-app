import { beforeEach, describe, expect, it } from 'vitest';
import { memoryStore } from '../account/backend';
import type { Account } from '../account/model';
import { Ops } from './ops';
import { OpsStore } from './store';

const account: Account = { id: 'acc', business: 'Studio Rupa', createdAt: 0, trialEndsAt: Infinity };

function setup() {
  const toasts: string[] = [];
  const store = new OpsStore(memoryStore(), account.id, account.business, () => Date.UTC(2026, 9, 19, 5));
  const ops = new Ops(store, account, { toast: (message) => toasts.push(message), devicePointId: () => 'k1' });
  ops.sites = {
    locations: [{ id: 'mall', name: 'Grand Indonesia', city: 'Jakarta', address: '', createdAt: 0 }],
    points: [
      { id: 'k1', locationId: 'mall', name: 'Kiosk 1', code: 'GRA-01', active: true, createdAt: 0 },
      { id: 'k2', locationId: 'mall', name: 'Kiosk 2', code: 'GRA-02', active: true, createdAt: 0 },
    ],
  };
  return { ops, store, toasts };
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = memoryStore();
});

describe('a day at the till', () => {
  it('sells a session with a voucher, issues a receipt code and a queue ticket, then refunds with a PIN', async () => {
    const { ops } = setup();
    ops.saveVoucher({ code: 'half', kind: 'percent', value: 50, scope: 'multi', boothIds: [], maxUses: 5, validFrom: '', validTo: '', happyHour: null, frameIds: [], eventMode: false, active: true });
    expect(() => ops.createOrder({ lines: [{ kind: 'session', refId: 'photobox', label: 'Photo strip', unitPrice: 35_000, qty: 1 }], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null })).toThrow('Open a shift');
    ops.openShift('mall', 200_000);

    const order = ops.createOrder({
      lines: [{ kind: 'session', refId: 'photobox', label: 'Photo strip', unitPrice: 35_000, qty: 1, mode: 'strip' }, { kind: 'print', refId: '4R', label: 'Extra 4R', unitPrice: 15_000, qty: 2, size: '4R' }],
      presetId: null,
      voucherCode: 'HALF',
      channel: 'cashier',
      branchId: 'mall',
      boothId: null,
    });
    expect(order.total).toBe(47_500);
    expect(ops.pay(order.id, 'cash', 50_000)).toBe(2_500);

    const paid = ops.order(order.id);
    expect(paid.status).toBe('paid');
    expect(paid.sessionVouchers).toHaveLength(1);
    expect(paid.ticketNumbers).toEqual(['A001']);
    expect(ops.state.tickets[0].boothIds).toEqual(['k1', 'k2']);
    expect(ops.state.vouchers.find((v) => v.code === 'HALF')?.uses).toBe(1);

    // The receipt code unlocks one session at a booth, once.
    const code = paid.sessionVouchers[0];
    expect(ops.redeemAtBooth(code, 'k1', 35_000).discount).toBe(35_000);
    ops.startSession({ boothId: 'k1', mode: 'strip', price: 0, orderId: order.id, voucherCode: code, frameId: null });
    expect(() => ops.redeemAtBooth(code, 'k2', 35_000)).toThrow('already used');

    // Refund the prints: needs a supervisor PIN.
    await ops.saveStaff({ name: 'Sari', role: 'supervisor', branchIds: [], email: '', phone: '', onDuty: true, active: true }, '2468');
    const printLine = paid.lines.find((line) => line.kind === 'print')!;
    await expect(ops.refund(order.id, printLine.id, 'Blurry', '1111')).rejects.toThrow('does not belong to a supervisor');
    expect(await ops.refund(order.id, printLine.id, 'Blurry', '2468')).toBe(30_000);
    await expect(ops.refund(order.id, printLine.id, 'Again', '2468')).rejects.toThrow('refunded already');

    const slip = ops.closeShift(ops.openShiftFor('mall')!.id, 217_500);
    expect(slip).toMatchObject({ gross: 47_500, refunds: 30_000, expectedCash: 217_500, variance: 0 });
    expect(ops.state.activity.map((entry) => entry.kind)).toContain('order.refund');
    expect(ops.outbox.pending().length).toBeGreaterThan(0);
  });

  it('finishes a QRIS order when the gateway calls back', async () => {
    const { ops } = setup();
    ops.openShift('mall', 0);
    const order = ops.createOrder({ lines: [{ kind: 'session', refId: 'photobox', label: 'GIF', unitPrice: 30_000, qty: 1 }], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null });
    const payment = await ops.chargeQris(order.id);
    expect(payment.qrString).toContain('ID.CO.QRIS.WWW');
    expect(ops.order(order.id).status).toBe('open');
    ops.gateway.simulatePaid!(payment.reference);
    expect(ops.order(order.id).status).toBe('paid');
  });

  it('keeps merchandise stock honest', () => {
    const { ops } = setup();
    ops.openShift('mall', 0);
    ops.edit('settings.manage', 'product', 'add', (draft) => draft.products.push({ id: 'mug', name: 'Mug', sku: 'M1', price: 45_000, stock: 1 }));
    const line = { kind: 'merch' as const, refId: 'mug', label: 'Mug', unitPrice: 45_000, qty: 2 };
    expect(() => ops.createOrder({ lines: [line], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null })).toThrow('Only 1 Mug left');
    const order = ops.createOrder({ lines: [{ ...line, qty: 1 }], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null });
    ops.pay(order.id, 'card', 45_000, 'APPR-123');
    expect(ops.state.products[0].stock).toBe(0);
  });

  it('stops a cashier from refunding or managing staff', async () => {
    const { ops } = setup();
    await ops.saveStaff({ name: 'Budi', role: 'cashier', branchIds: ['mall'], email: '', phone: '', onDuty: true, active: true }, '1357');
    const budi = ops.state.staff.find((person) => person.name === 'Budi')!;
    await expect(ops.switchActor(budi.id, '0000')).rejects.toThrow('Wrong PIN');
    await ops.switchActor(budi.id, '1357');
    expect(ops.can('pos.sell')).toBe(true);
    await expect(ops.saveStaff({ name: 'X', role: 'cashier', branchIds: [], email: '', phone: '', onDuty: false, active: true }, '')).rejects.toThrow('not allowed');
  });
});

describe('queue and alerts', () => {
  it('calls across booths and messages the customer', () => {
    const { ops } = setup();
    const ticket = ops.issueTicket({ boothIds: ['k1', 'k2'], name: 'Ani', phone: '+62811', email: '', checkedIn: true });
    expect(ops.callNext('k2')?.id).toBe(ticket.id);
    expect(ops.callNext('k1')).toBeNull();
    expect(ops.state.notifications[0]).toMatchObject({ channel: 'whatsapp', to: '+62811' });
  });

  it('raises a low-paper alert once, pops it on the booth and notifies the owner', async () => {
    const { ops, toasts } = setup();
    await ops.saveStaff({ ...ops.state.staff[0], email: 'owner@rupa.id', phone: '+62812' }, '');
    ops.edit('devices.manage', 'printer', 'add', (draft) =>
      draft.printers.push({ id: 'p1', name: 'DNP DS-RX1', brand: 'dnp', boothIds: ['k1'], sizes: ['4R'], paperLeft: 5, lowThreshold: 20, status: 'ok', error: '' }),
    );
    ops.checkAlerts();
    ops.checkAlerts();
    expect(ops.state.alerts.filter((alert) => !alert.resolvedAt)).toHaveLength(1);
    expect(toasts).toEqual(['DNP DS-RX1 has 5 sheets left.']);
    expect(ops.state.notifications.map((n) => n.channel).sort()).toEqual(['email', 'whatsapp']);
  });
});

describe('managing payments', () => {
  it('records the fee and the wallet, and refuses a method switched off for the channel', () => {
    const { ops } = setup();
    ops.openShift('mall', 0);
    const line = { kind: 'session' as const, refId: 'photobox', label: 'GIF', unitPrice: 30_000, qty: 1 };
    const order = ops.createOrder({ lines: [line], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null });
    expect(() => ops.pay(order.id, 'ewallet', 30_000, 'GP-1')).toThrow('Pick the e-wallet');
    ops.pay(order.id, 'ewallet', 30_000, 'GP-1', { wallet: 'GoPay' });
    expect(ops.order(order.id).payments[0]).toMatchObject({ status: 'paid', wallet: 'GoPay', fee: 450 });

    ops.savePaymentSettings((draft) => (draft.methods.card.cashier = false), 'No cards at the till');
    const next = ops.createOrder({ lines: [line], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null });
    expect(() => ops.pay(next.id, 'card', 30_000, 'APPR')).toThrow('Card is switched off for the till');
    const booth = ops.createOrder({ lines: [line], presetId: null, voucherCode: '', channel: 'booth', branchId: 'mall', boothId: 'k1' });
    expect(() => ops.pay(booth.id, 'cash', 30_000)).toThrow('Cash is switched off for the booth');
  });

  it('expires a QR after its time, cancels one with a reason, and confirms one by hand with a PIN', async () => {
    let now = Date.UTC(2026, 9, 19, 5);
    const store = new OpsStore(memoryStore(), account.id, account.business, () => now);
    const ops = new Ops(store, account, { toast: () => {}, devicePointId: () => 'k1' });
    ops.sites = { locations: [{ id: 'mall', name: 'Mall', city: 'Jakarta', address: '', createdAt: 0 }], points: [{ id: 'k1', locationId: 'mall', name: 'Kiosk 1', code: 'K1', active: true, createdAt: 0 }] };
    ops.savePaymentSettings((draft) => (draft.gateway.qrExpiryMinutes = 5), 'Short QR life');
    const line = { kind: 'session' as const, refId: 'photobox', label: 'GIF', unitPrice: 30_000, qty: 1 };

    const first = ops.createOrder({ lines: [line], presetId: null, voucherCode: '', channel: 'booth', branchId: 'mall', boothId: 'k1' });
    const qr = await ops.chargeQris(first.id);
    expect(qr.expiresAt).toBe(now + 5 * 60_000);
    expect(qr.gateway).toBe('Midtrans sandbox');
    expect(ops.expirePayments()).toBe(0);
    now += 6 * 60_000;
    expect(ops.expirePayments()).toBe(1);
    expect(ops.order(first.id).payments[0].status).toBe('expired');
    expect(ops.order(first.id).status).toBe('open');

    const second = await ops.chargeQris(first.id);
    expect(() => ops.cancelPayment(first.id, second.id, '')).toThrow('Enter a reason');
    ops.cancelPayment(first.id, second.id, 'Customer left');
    expect(ops.order(first.id).payments[1]).toMatchObject({ status: 'cancelled', note: 'Customer left' });
    expect(() => ops.cancelPayment(first.id, second.id, 'Again')).toThrow('is cancelled');

    await ops.saveStaff({ name: 'Sari', role: 'supervisor', branchIds: [], email: '', phone: '', onDuty: true, active: true }, '2468');
    const third = await ops.chargeQris(first.id);
    await expect(ops.confirmPayment(first.id, third.id, 'BCA 7781', '0000')).rejects.toThrow('does not belong to a supervisor');
    await ops.confirmPayment(first.id, third.id, 'BCA 7781', '2468');
    expect(ops.order(first.id).status).toBe('paid');
    expect(ops.order(first.id).payments[2].note).toBe('Confirmed by Sari from BCA 7781');
    expect(ops.state.activity[0].kind).toBe('payment.confirm');
  });
});
