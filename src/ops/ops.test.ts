import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error: a plain Node module shared with scripts/serve.mjs, with no type declarations.
import { QrisDesk } from '../../scripts/qris-mutations.mjs';
import { memoryStore } from '../account/backend';
import type { Account } from '../account/model';
import { getShots, saveShot } from '../gallery';
import { can, permissionsOf, type Permission } from './access';
import { crc16 } from './encoders';
import { Ops } from './ops';
import type { StaticQrisGateway } from './static-qris';
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
    expect(() => ops.createOrder({ lines: [{ kind: 'session', refId: 'photobox', label: 'Photo strip', unitPrice: 35_000, qty: 1 }], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null })).toThrow('Buka shift');
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
    expect(() => ops.redeemAtBooth(code, 'k2', 35_000)).toThrow('sudah dipakai');

    // Refund the prints: needs a supervisor PIN.
    await ops.saveStaff({ name: 'Sari', role: 'supervisor', branchIds: [], email: '', phone: '', onDuty: true, active: true }, '2468');
    const printLine = paid.lines.find((line) => line.kind === 'print')!;
    await expect(ops.refund(order.id, printLine.id, 'Blurry', '1111')).rejects.toThrow('bukan milik supervisor');
    // A double tap sends two refunds while the PIN is still being checked: one goes through.
    const both = await Promise.allSettled([ops.refund(order.id, printLine.id, 'Blurry', '2468'), ops.refund(order.id, printLine.id, 'Blurry', '2468')]);
    expect(both.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(both.find((result) => result.status === 'fulfilled')).toMatchObject({ value: 30_000 });
    expect(ops.state.refunds).toHaveLength(1);
    await expect(ops.refund(order.id, printLine.id, 'Again', '2468')).rejects.toThrow('sudah di-refund');

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

  it('settles a static QRIS order from the notification the booth computer matched', async () => {
    const { ops } = setup();
    ops.openShift('mall', 0);
    const field = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;
    const body = [field('00', '01'), field('01', '11'), field('26', field('00', 'ID.CO.QRIS.WWW') + field('01', 'ID1234567890')), field('52', '7221'), field('53', '360'), field('58', 'ID'), field('59', 'STUDIO RUPA'), field('60', 'BANDUNG')].join('') + '6304';
    ops.savePaymentSettings((draft) => Object.assign(draft.gateway, { provider: 'static', staticQris: body + crc16(body).toString(16).toUpperCase().padStart(4, '0'), uniqueCode: 'always' }), 'Own QRIS');
    // The booth computer, standing in for scripts/serve.mjs.
    const desk = new QrisDesk({ token: 'secret' });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const { key, amount, expiresInMs, uniqueCode } = JSON.parse(String(init.body));
        return Response.json(desk.charge(key, amount, expiresInMs, uniqueCode === 'always'));
      }
      if (init?.method === 'DELETE') return Response.json({ ok: desk.release(decodeURIComponent(url.split('/').pop()!)) });
      return Response.json({ paid: desk.paidSince(0), now: Date.now() });
    });
    try {
      const order = ops.createOrder({ lines: [{ kind: 'session', refId: 'photobox', label: 'GIF', unitPrice: 30_000, qty: 1 }], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null });
      const payment = await ops.chargeQris(order.id);
      expect(payment).toMatchObject({ amount: 30_000, uniqueCode: 1, gateway: 'QRIS statis' });
      expect(payment.qrString).toContain('540530001');
      expect(ops.gateway.simulated).toBe(false);

      desk.ingest('Pembayaran QRIS Rp 30.000 diterima');
      await (ops.gateway as StaticQrisGateway).check();
      expect(ops.order(order.id).status).toBe('open');

      desk.ingest('Pembayaran QRIS Rp 30.001 diterima');
      await (ops.gateway as StaticQrisGateway).check();
      await (ops.gateway as StaticQrisGateway).check();
      expect(ops.order(order.id).status).toBe('paid');
      expect(ops.order(order.id).payments.filter((entry) => entry.status === 'paid')).toHaveLength(1);

      // A cancelled QR gives its amount back to the next customer.
      const next = ops.createOrder({ lines: [{ kind: 'session', refId: 'photobox', label: 'GIF', unitPrice: 30_000, qty: 1 }], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null });
      const waiting = await ops.chargeQris(next.id);
      ops.cancelPayment(next.id, waiting.id, 'Customer left');
      expect(desk.waiting()).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('charges QRIS once for a double tap and shows a waiting QR again', async () => {
    const { ops } = setup();
    ops.openShift('mall', 0);
    const order = ops.createOrder({ lines: [{ kind: 'session', refId: 'photobox', label: 'GIF', unitPrice: 30_000, qty: 1 }], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null });
    const [first, second] = await Promise.all([ops.chargeQris(order.id), ops.chargeQris(order.id)]);
    expect(second.id).toBe(first.id);
    expect((await ops.chargeQris(order.id)).id).toBe(first.id);
    expect(ops.order(order.id).payments).toHaveLength(1);
    // A repeat callback from the gateway changes nothing.
    ops.gateway.simulatePaid!(first.reference);
    ops.gateway.simulatePaid!(first.reference);
    expect(ops.order(order.id).payments.filter((payment) => payment.status === 'paid')).toHaveLength(1);
    expect(ops.order(order.id).status).toBe('paid');
  });

  it('settles an open order when the gateway reports a QR this device had expired', async () => {
    let now = Date.UTC(2026, 9, 19, 5);
    const store = new OpsStore(memoryStore(), account.id, account.business, () => now);
    const ops = new Ops(store, account, { toast: () => {}, devicePointId: () => 'k1' });
    ops.sites = { locations: [{ id: 'mall', name: 'Mall', city: 'Jakarta', address: '', createdAt: 0 }], points: [{ id: 'k1', locationId: 'mall', name: 'Kiosk 1', code: 'K1', active: true, createdAt: 0 }] };
    const order = ops.createOrder({ lines: [{ kind: 'session', refId: 'photobox', label: 'GIF', unitPrice: 30_000, qty: 1 }], presetId: null, voucherCode: '', channel: 'booth', branchId: 'mall', boothId: 'k1' });
    const late = await ops.chargeQris(order.id);
    now += 60 * 60_000;
    ops.expirePayments();
    const fresh = await ops.chargeQris(order.id);
    expect(fresh.id).not.toBe(late.id);
    ops.gateway.simulatePaid!(late.reference);
    expect(ops.order(order.id).status).toBe('paid');
    // The QR still on screen closes, and a payment arriving for it now changes nothing.
    expect(ops.order(order.id).payments.find((payment) => payment.id === fresh.id)?.status).toBe('expired');
    ops.gateway.simulatePaid!(fresh.reference);
    expect(ops.order(order.id).payments.filter((payment) => payment.status === 'paid')).toHaveLength(1);
  });

  it('keeps merchandise stock honest', () => {
    const { ops } = setup();
    ops.openShift('mall', 0);
    ops.edit('settings.manage', 'product', 'add', (draft) => draft.products.push({ id: 'mug', name: 'Mug', sku: 'M1', price: 45_000, stock: 1 }));
    const line = { kind: 'merch' as const, refId: 'mug', label: 'Mug', unitPrice: 45_000, qty: 2 };
    expect(() => ops.createOrder({ lines: [line], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null })).toThrow('Stok Mug tinggal 1');
    const order = ops.createOrder({ lines: [{ ...line, qty: 1 }], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null });
    ops.pay(order.id, 'card', 45_000, 'APPR-123');
    expect(ops.state.products[0].stock).toBe(0);
  });

  it('stops a cashier from refunding or managing staff', async () => {
    const { ops } = setup();
    await ops.saveStaff({ name: 'Budi', role: 'cashier', branchIds: ['mall'], email: '', phone: '', onDuty: true, active: true }, '1357');
    const budi = ops.state.staff.find((person) => person.name === 'Budi')!;
    await expect(ops.switchActor(budi.id, '0000')).rejects.toThrow('PIN salah');
    await ops.switchActor(budi.id, '1357');
    expect(ops.can('pos.sell')).toBe(true);
    await expect(ops.saveStaff({ name: 'X', role: 'cashier', branchIds: [], email: '', phone: '', onDuty: false, active: true }, '')).rejects.toThrow('tidak punya izin');
    // The owner set no PIN, so the cashier cannot take the owner's place on this device.
    await expect(ops.switchActor(ops.state.staff[0].id, '')).rejects.toThrow('belum punya PIN');
    expect(ops.actor()?.id).toBe(budi.id);
  });

  it('takes a turned-off person\'s access away instead of handing the device to the owner', async () => {
    const { ops } = setup();
    expect(ops.actor()?.role).toBe('owner');
    await ops.saveStaff({ name: 'Budi', role: 'cashier', branchIds: [], email: '', phone: '', onDuty: true, active: true }, '1357');
    const budi = ops.state.staff.find((person) => person.name === 'Budi')!;
    await ops.switchActor(budi.id, '1357');
    // The owner turns Budi off from another device; this one still has Budi on it.
    ops.store.update((draft) => void (draft.staff.find((person) => person.id === budi.id)!.active = false));
    expect(ops.actor()).toBeNull();
    expect(ops.can('pos.sell')).toBe(false);
  });

  it('pauses PIN entry after five wrong PINs and logs it', async () => {
    const { ops, store } = setup();
    await ops.saveStaff({ name: 'Sari', role: 'supervisor', branchIds: [], email: '', phone: '', onDuty: true, active: true }, '2468');
    const sari = ops.state.staff.find((person) => person.name === 'Sari')!;
    for (let i = 0; i < 5; i += 1) await expect(ops.switchActor(sari.id, '1111')).rejects.toThrow('PIN salah');
    expect(ops.state.activity[0].kind).toBe('auth.pin-locked');
    // The right PIN waits too, and so do refunds and hand confirmations on this device.
    await expect(ops.switchActor(sari.id, '2468')).rejects.toThrow('Coba lagi dalam 5 menit');
    const clock = vi.spyOn(store, 'now').mockReturnValue(Date.UTC(2026, 9, 19, 5, 6));
    await ops.switchActor(sari.id, '2468');
    expect(ops.actor()?.id).toBe(sari.id);
    clock.mockRestore();
  });
});

describe('booth capture recovery', () => {
  it('clears incomplete photos without charging a paid session again', async () => {
    const { ops } = setup();
    const order = ops.createOrder({
      lines: [{ kind: 'session', refId: 'photobox', label: 'Photo strip', unitPrice: 35_000, qty: 1, mode: 'strip' }],
      presetId: null, voucherCode: '', channel: 'booth', branchId: 'mall', boothId: 'k1',
    });
    const payment = await ops.chargeQris(order.id);
    ops.gateway.simulatePaid!(payment.reference);
    const session = ops.startSession({ boothId: 'k1', mode: 'strip', price: 35_000, orderId: order.id, voucherCode: null, frameId: null });
    const shot = await saveShot(new Blob(['partial'], { type: 'image/png' }), 'snapshot', 'k1', null, session.id);
    ops.attachShot(session.id, shot.id);

    await ops.clearSessionShots(session.id);
    expect(ops.state.sessions.find((entry) => entry.id === session.id)?.shotIds).toEqual([]);
    expect(await getShots([shot.id])).toEqual([]);
    expect(ops.order(order.id).status).toBe('paid');

    ops.endSession(session.id, false, '', undefined, 'Camera disconnected');
    expect(ops.state.sessions.find((entry) => entry.id === session.id)?.failureReason).toBe('Camera disconnected');
    expect(ops.state.activity[0].message).toContain('menutup sesi gagal');
  });

  it('restores a phone link after a completed session while keeping the saved file', async () => {
    const { ops } = setup();
    const session = ops.startSession({ boothId: 'k1', mode: 'strip', price: 0, orderId: null, voucherCode: null, frameId: null });
    const shot = await saveShot(new Blob(['photo'], { type: 'image/png' }), 'photobooth', 'k1', null, session.id);
    ops.attachShot(session.id, shot.id);
    expect(() => ops.setSessionDelivery(session.id, 'http://booth/#g=token')).toThrow('tidak bisa dipulihkan');
    ops.endSession(session.id, false, '');
    ops.setSessionDelivery(session.id, 'http://booth/#g=token');
    expect(ops.state.sessions.find((entry) => entry.id === session.id)?.deliveryUrl).toBe('http://booth/#g=token');
    expect(await getShots([shot.id])).toHaveLength(1);
    expect(ops.state.activity[0].kind).toBe('session.delivery');
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
    expect(toasts).toEqual(['Kertas DNP DS-RX1 tinggal 5 lembar.']);
    expect(ops.state.notifications.map((n) => n.channel).sort()).toEqual(['email', 'whatsapp']);
  });
});

describe('managing payments', () => {
  it('records the fee and the wallet, and refuses a method switched off for the channel', () => {
    const { ops } = setup();
    ops.openShift('mall', 0);
    const line = { kind: 'session' as const, refId: 'photobox', label: 'GIF', unitPrice: 30_000, qty: 1 };
    const order = ops.createOrder({ lines: [line], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null });
    expect(() => ops.pay(order.id, 'ewallet', 30_000, 'GP-1')).toThrow('Pilih e-wallet');
    ops.pay(order.id, 'ewallet', 30_000, 'GP-1', { wallet: 'GoPay' });
    expect(ops.order(order.id).payments[0]).toMatchObject({ status: 'paid', wallet: 'GoPay', fee: 450 });

    ops.savePaymentSettings((draft) => (draft.methods.card.cashier = false), 'No cards at the till');
    const next = ops.createOrder({ lines: [line], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null });
    expect(() => ops.pay(next.id, 'card', 30_000, 'APPR')).toThrow('Kartu dimatikan untuk kasir');
    const booth = ops.createOrder({ lines: [line], presetId: null, voucherCode: '', channel: 'booth', branchId: 'mall', boothId: 'k1' });
    expect(() => ops.pay(booth.id, 'cash', 30_000)).toThrow('Tunai dimatikan untuk booth');
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
    expect(() => ops.cancelPayment(first.id, second.id, '')).toThrow('Isi alasan');
    ops.cancelPayment(first.id, second.id, 'Customer left');
    expect(ops.order(first.id).payments[1]).toMatchObject({ status: 'cancelled', note: 'Customer left' });
    expect(() => ops.cancelPayment(first.id, second.id, 'Again')).toThrow('dibatalkan');

    await ops.saveStaff({ name: 'Sari', role: 'supervisor', branchIds: [], email: '', phone: '', onDuty: true, active: true }, '2468');
    const third = await ops.chargeQris(first.id);
    await expect(ops.confirmPayment(first.id, third.id, 'BCA 7781', '0000')).rejects.toThrow('bukan milik supervisor');
    const confirms = await Promise.allSettled([ops.confirmPayment(first.id, third.id, 'BCA 7781', '2468'), ops.confirmPayment(first.id, third.id, 'BCA 7781', '2468')]);
    expect(confirms.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(ops.state.activity.filter((entry) => entry.kind === 'payment.confirm')).toHaveLength(1);
    expect(ops.order(first.id).status).toBe('paid');
    expect(ops.order(first.id).payments[2].note).toBe('Dikonfirmasi oleh Sari dari BCA 7781');
    expect(ops.state.activity[0].kind).toBe('payment.confirm');
  });
});

describe('a party from the gate to the print', () => {
  it('photographs the party at the gate, finds them by ticket at the booth and sells the preset', async () => {
    const { ops } = setup();
    const ticket = ops.issueTicket({ boothIds: ['k1'], name: 'Dina', phone: '', email: '', checkedIn: false });
    expect(ops.findTicket(ticket.number).id).toBe(ticket.id);
    expect(ops.findTicket(`https://booth.test/#checkin=${ticket.token}`).id).toBe(ticket.id);
    expect(() => ops.findTicket('A999')).toThrow('A999 tidak ada di antrean');

    // The gate scan checks the ticket in, then the camera's faces are filed under it.
    expect(ops.arrive(ticket.number).checkedIn).toBe(true);
    expect(ops.arrive(ticket.number).status).toBe('waiting');
    const photo = new Blob(['jpeg'], { type: 'image/jpeg' });
    await ops.addFace(photo, 'k1', ticket.id);
    await ops.addFace(photo, 'k1', ticket.id);
    await ops.addFace(photo, 'k1');
    expect(ops.facesForTicket(ticket.id)).toHaveLength(2);
    expect(ops.state.activity[0].message).toBe('Kiosk 1 mengambil foto wajah untuk preset AI.');
    expect(ops.state.activity[1].message).toBe(`Kiosk 1 mengambil foto wajah untuk tiket ${ticket.number}.`);
    const [dina] = ops.facesForTicket(ticket.id);
    ops.tagFace(dina.id, '  Dina  ');
    expect(ops.facesForTicket(ticket.id)[0].name).toBe('Dina');
    expect(ops.state.activity[0].message).toBe('Memberi nama wajah Dina.');
    ops.tagFace(dina.id, '');
    expect(ops.state.activity[0].message).toBe('Menghapus nama dari wajah.');
    expect(() => ops.tagFace('gone', 'X')).toThrow('Wajah itu sudah tidak ada.');
    ops.tagFace(dina.id, 'Dina');

    // The booth calls them, and the preset flow finds the ticket it is serving.
    expect(ops.callNext('k1')?.id).toBe(ticket.id);
    expect(ops.servingAt('k1')?.number).toBe(ticket.number);
    expect(ops.servingAt('k2')).toBeNull();

    ops.savePresetPrice(25_000);
    const order = ops.createOrder({ lines: [{ kind: 'preset', refId: 'cover', label: 'AI preset · Magazine cover', unitPrice: ops.state.settings.presetPrice, qty: 1 }], presetId: null, voucherCode: '', channel: 'booth', branchId: 'mall', boothId: 'k1' });
    expect(order.total).toBe(25_000);
    const payment = await ops.chargeQris(order.id);
    ops.gateway.simulatePaid!(payment.reference);
    expect(ops.order(order.id).status).toBe('paid');

    ops.savePresetPrice(0);
    expect(ops.state.activity[0].message).toBe('Preset AI gratis.');
  });
});

describe('team sign-in', () => {
  it('signs the owner in, invites a cashier once, and stops sign-in when they leave', async () => {
    const { createLocalBackend } = await import('../account/backend');
    const accounts = createLocalBackend(memoryStore());
    const session = await accounts.register({ business: 'Dusun Bambu', name: 'Rizky', email: 'rizky@dusunbambu.id', password: 'bambu2026' }, 'r1');
    const store = new OpsStore(memoryStore(), session.account.id, session.account.business);
    const ops = new Ops(store, session.account, { toast: () => {}, devicePointId: () => null });
    ops.accounts = accounts;
    ops.adoptSession(session.member);
    expect(ops.actor()).toMatchObject({ name: 'Rizky', email: 'rizky@dusunbambu.id', role: 'owner' });
    expect(ops.state.activity[0].message).toBe('Rizky masuk.');
    // Opening the app again on the same session is no new sign-in.
    ops.adoptSession(session.member);
    expect(ops.state.activity.filter((entry) => entry.kind === 'auth.signin')).toHaveLength(1);

    const id = await ops.saveStaff({ name: 'Sari', role: 'cashier', branchIds: [], email: 'Sari@DusunBambu.id', phone: '', onDuty: true, active: true }, '');
    await expect(ops.saveStaff({ name: 'Dewi', role: 'cashier', branchIds: [], email: 'sari@dusunbambu.id', phone: '', onDuty: true, active: true }, '')).rejects.toThrow('sudah dipakai orang lain');
    const [first, again] = await Promise.all([ops.inviteMember(id, 'k'), ops.inviteMember(id, 'k')]);
    expect(again.code).toBe(first.code);
    expect(ops.member(id)?.status).toBe('invited');

    await accounts.signOut();
    await accounts.acceptInvite(first.code, 'kopi2026', 'a');
    await accounts.signOut();
    await accounts.signIn('rizky@dusunbambu.id', 'bambu2026');
    await ops.refreshMembers();
    expect(ops.member(id)?.status).toBe('active');

    await ops.saveStaff({ ...ops.state.staff.find((person) => person.id === id)!, active: false }, '');
    expect(ops.member(id)?.status).toBe('disabled');
    await accounts.signOut();
    await expect(accounts.signIn('sari@dusunbambu.id', 'kopi2026')).rejects.toThrow('dimatikan');
  });

  it('keeps a cashier away from other people\'s sign-in', async () => {
    const { ops } = setup();
    await ops.saveStaff({ name: 'Budi', role: 'cashier', branchIds: [], email: '', phone: '', onDuty: true, active: true }, '1357');
    await ops.switchActor(ops.state.staff.find((person) => person.name === 'Budi')!.id, '1357');
    await expect(ops.resetMember(ops.state.staff[0].id)).rejects.toThrow('tidak punya izin');
  });
});

describe('editable roles', () => {
  it('gives a role new permissions, keeps the owner whole, and goes back to standard', async () => {
    const { ops } = setup();
    await ops.saveStaff({ name: 'Budi', role: 'cashier', branchIds: [], email: '', phone: '', onDuty: true, active: true }, '1357');
    const budi = ops.state.staff.find((person) => person.name === 'Budi')!;
    expect(can(budi, 'reports.view')).toBe(false);

    ops.saveRole('cashier', [...permissionsOf('cashier'), 'reports.view', 'not.a.permission' as Permission]);
    expect(can(budi, 'reports.view')).toBe(true);
    expect(ops.state.settings.rolePermissions.cashier).not.toContain('not.a.permission');
    expect(ops.state.activity[0].kind).toBe('role.save');
    expect(() => ops.saveRole('owner', [])).toThrow('Pemilik selalu punya semua izin');

    ops.saveRole('cashier', []);
    await ops.switchActor(budi.id, '1357');
    expect(() => ops.createOrder({ lines: [{ kind: 'merch', refId: 'x', label: 'X', unitPrice: 1, qty: 1 }], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null })).toThrow('tidak punya izin');
    expect(() => ops.resetRole('cashier')).toThrow('tidak punya izin');

    // The owner has no PIN, so they come back by signing in.
    ops.adoptSession({ userId: ops.state.staff[0].id, accountId: account.id, name: 'Owner', email: '', status: 'active', createdAt: 0, lastSignInAt: 1, failedAttempts: 0, lockedUntil: 0, inviteExpiresAt: null });
    ops.resetRole('cashier');
    expect(permissionsOf('cashier')).toContain('pos.sell');
    expect(ops.state.settings.rolePermissions).toEqual({});
  });
});

