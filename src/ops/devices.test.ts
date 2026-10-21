import { describe, expect, it } from 'vitest';
import { memoryStore } from '../account/backend';
import type { BoothHealth, Printer, RoutingRule, Staff } from './model';
import { Outbox, backoff, type OutboxItem } from './outbox';
import { afterPrint, noPrinterReason, paperState, pickPrinter } from './printing';
import { OFFLINE_AFTER_MS, reconcileAlerts, routeAlert, wantedAlerts } from './telemetry';

const printer = (id: string, over: Partial<Printer> = {}): Printer => ({
  id,
  name: id,
  brand: 'dnp',
  boothIds: ['b1'],
  sizes: ['4R', '6R'],
  paperLeft: 300,
  lowThreshold: 50,
  status: 'ok',
  error: '',
  ...over,
});

describe('printing', () => {
  it('picks a working printer with paper for the booth and size, most paper first', () => {
    const printers = [printer('p1', { paperLeft: 80 }), printer('p2', { paperLeft: 200, boothIds: ['b1', 'b2'] }), printer('p3', { status: 'error' })];
    expect(pickPrinter(printers, 'b1', '4R')?.id).toBe('p2');
    expect(pickPrinter(printers, 'b2', '4R')?.id).toBe('p2');
    expect(pickPrinter(printers, 'b1', 'A3')).toBeNull();
    expect(noPrinterReason(printers, 'b1', 'A3')).toBe('No printer here takes A3.');
    expect(noPrinterReason(printers, 'b9', '4R')).toBe('No printer is assigned to this booth.');
  });

  it('counts paper down and reports its state', () => {
    expect(afterPrint(printer('p', { paperLeft: 2 }), 5).paperLeft).toBe(0);
    expect(paperState({ paperLeft: 50, lowThreshold: 50 })).toBe('low');
    expect(paperState({ paperLeft: 0, lowThreshold: 50 })).toBe('empty');
  });
});

describe('telemetry', () => {
  const booths = [{ id: 'b1', name: 'Kiosk 1', branchId: 'mall' }, { id: 'b2', name: 'Mirror', branchId: 'mall' }];
  const health = (boothId: string, over: Partial<BoothHealth> = {}): BoothHealth => ({
    boothId,
    lastHeartbeat: 1000,
    version: '1.0.0',
    cameraConnected: true,
    cameraBattery: null,
    online: true,
    ...over,
  });

  it('wants alerts for paper, printer errors, cameras and silent booths', () => {
    const now = 1000 + OFFLINE_AFTER_MS + 1;
    const wanted = wantedAlerts(
      [printer('p1', { paperLeft: 10 }), printer('p2', { status: 'error', error: 'Ribbon jam' })],
      [health('b1', { lastHeartbeat: now - 1000, cameraBattery: 15 }), health('b2')],
      booths,
      now,
    );
    expect(wanted.map((alert) => alert.kind)).toEqual(['low-paper', 'printer-error', 'camera-battery', 'booth-offline']);
    expect(wanted[1].message).toBe('p2: Ribbon jam.');
  });

  it('opens each problem once and resolves it when it clears', () => {
    let id = 0;
    const want = [{ kind: 'low-paper' as const, subject: 'paper:p1', branchId: 'mall', boothId: 'b1', message: 'low' }];
    const first = reconcileAlerts([], want, 1, () => `a${++id}`);
    expect(first.opened).toHaveLength(1);
    const again = reconcileAlerts(first.alerts, [{ ...want[0], message: 'lower' }], 2, () => `a${++id}`);
    expect(again.opened).toHaveLength(0);
    expect(again.alerts[0]).toMatchObject({ id: 'a1', message: 'lower', openedAt: 1 });
    const cleared = reconcileAlerts(again.alerts, [], 3, () => `a${++id}`);
    expect(cleared.resolved[0]).toMatchObject({ id: 'a1', resolvedAt: 3 });
    expect(cleared.alerts).toHaveLength(1);
  });

  const staff = (id: string, over: Partial<Staff>): Staff => ({
    id,
    name: id,
    role: 'cashier',
    branchIds: [],
    pinHash: '',
    pinSalt: '',
    email: `${id}@x.id`,
    phone: `+62${id.length}`,
    onDuty: false,
    active: true,
    ...over,
  });
  const people = [staff('owner', { role: 'owner' }), staff('ani', { onDuty: true, branchIds: ['mall'] }), staff('budi', { onDuty: true, branchIds: ['airport'] })];

  it('routes to the owner and on-duty staff of the branch by default', () => {
    const deliveries = routeAlert({ kind: 'low-paper', branchId: 'mall' }, [], people);
    expect(deliveries.map((d) => `${d.channel}:${d.name}`)).toEqual([
      'popup:Booth screen',
      'email:owner',
      'email:ani',
      'whatsapp:owner',
      'whatsapp:ani',
    ]);
  });

  it('lets a branch rule narrow the channels and people', () => {
    const rules: RoutingRule[] = [{ id: 'r', branchId: 'mall', kinds: ['low-paper'], channels: ['whatsapp'], recipients: ['ani'] }];
    expect(routeAlert({ kind: 'low-paper', branchId: 'mall' }, rules, people).map((d) => d.to)).toEqual(['+623']);
    // Other alert kinds still use the default.
    expect(routeAlert({ kind: 'booth-offline', branchId: 'mall' }, rules, people)).toHaveLength(5);
  });
});

describe('outbox', () => {
  it('keeps items until the cloud takes them, in order, across a failure', async () => {
    const store = memoryStore();
    const received: string[] = [];
    let online = false;
    let clock = 0;
    const box = new Outbox(store, 'q', async (item: OutboxItem) => {
      if (!online) throw new Error('offline');
      received.push(item.id);
    }, () => clock);

    box.enqueue('s1', 'session', {});
    box.enqueue('s2', 'session', {});
    box.enqueue('s1', 'session', {});
    expect(await box.flush()).toBe(0);
    expect(box.pending().map((item) => [item.id, item.attempts])).toEqual([['s1', 1], ['s2', 0]]);

    online = true;
    // Still backing off.
    expect(await box.flush()).toBe(0);
    clock += backoff(1);
    expect(await box.flush()).toBe(2);
    expect(received).toEqual(['s1', 's2']);
    expect(box.pending()).toEqual([]);
  });

  it('survives a reload: the queue lives in storage', async () => {
    const store = memoryStore();
    new Outbox(store, 'q', async () => {}).enqueue('x', 'order', { total: 1 });
    expect(new Outbox(store, 'q', async () => {}).pending()[0].payload).toEqual({ total: 1 });
  });
});
