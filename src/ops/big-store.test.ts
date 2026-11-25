import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain Node module shared with scripts/serve.mjs, with no type declarations.
import { qrisHandler } from '../../scripts/qris-mutations.mjs';
import { memoryStore } from '../account/backend';
import { cachedStore, type Backing } from './big-store';
import { OpsStore } from './store';

function disk() {
  const saved = new Map<string, string>();
  const writes: string[] = [];
  let full = false;
  const backing: Backing = {
    load: async () => [...saved],
    async write(batch) {
      if (full) throw new Error('QuotaExceededError');
      for (const [key, value] of batch) {
        writes.push(key);
        if (value === null) saved.delete(key);
        else saved.set(key, value);
      }
    },
  };
  return { saved, writes, backing, fill: (state: boolean) => (full = state) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('cachedStore', () => {
  it('reads at once and writes to the disk behind', async () => {
    const { saved, writes, backing } = disk();
    const store = cachedStore([['a', '1']], backing);
    expect(store.getItem('a')).toBe('1');
    store.setItem('a', '2');
    store.setItem('a', '3');
    store.setItem('a', '4');
    expect(store.getItem('a')).toBe('4');
    await settle();
    expect(saved.get('a')).toBe('4');
    // The first write was under way; the two behind it went out as one.
    expect(writes).toEqual(['a', 'a']);
    store.removeItem('a');
    await settle();
    expect(store.getItem('a')).toBeNull();
    expect(saved.has('a')).toBe(false);
  });

  it('moves a record over from localStorage on first read', async () => {
    const { saved, backing } = disk();
    const legacy = memoryStore();
    legacy.setItem('vto:ops:acc', '{"orders":[]}');
    const store = cachedStore([], backing, { legacy });
    expect(store.getItem('vto:ops:acc')).toBe('{"orders":[]}');
    expect(store.getItem('missing')).toBeNull();
    await settle();
    expect(saved.get('vto:ops:acc')).toBe('{"orders":[]}');
    expect(legacy.getItem('vto:ops:acc')).toBeNull();
  });

  it('keeps the old copy and reports when the disk refuses, then retries', async () => {
    const { saved, backing, fill } = disk();
    const legacy = memoryStore();
    legacy.setItem('a', 'old');
    const failures: string[] = [];
    const store = cachedStore([], backing, { legacy, onFailure: (error) => failures.push(error.message) });
    fill(true);
    store.setItem('a', 'new');
    await settle();
    expect(failures).toEqual(['QuotaExceededError']);
    expect(store.getItem('a')).toBe('new');
    expect(legacy.getItem('a')).toBe('old');
    fill(false);
    store.setItem('b', '1');
    await settle();
    expect(saved.get('a')).toBe('new');
    expect(saved.get('b')).toBe('1');
  });

  it('tells a second window about a change', () => {
    const windows: Array<{ postMessage(writes: unknown): void; onmessage: ((event: { data: never }) => void) | null }> = [];
    const channel = () => {
      const mine = { onmessage: null, postMessage: (data: unknown) => windows.filter((other) => other !== mine).forEach((other) => other.onmessage?.({ data: data as never })) };
      windows.push(mine);
      return mine;
    };
    const till = new OpsStore(cachedStore([], disk().backing, { channel: channel() }), 'acc', 'Studio');
    const screen = new OpsStore(cachedStore([], disk().backing, { channel: channel() }), 'acc', 'Studio');
    let redraws = 0;
    screen.subscribe(() => (redraws += 1));
    till.update((draft) => void (draft.settings.queuePrefix = 'B'));
    expect(screen.state.settings.queuePrefix).toBe('B');
    expect(redraws).toBe(1);
    // The screen's next change builds on the till's, not on what it loaded at start.
    screen.update((draft) => void (draft.settings.idleSeconds = 90));
    expect(till.state.settings).toMatchObject({ queuePrefix: 'B', idleSeconds: 90 });
  });
});

describe('OpsStore', () => {
  it('leaves the state untouched when the device cannot save', () => {
    const kv = memoryStore();
    const store = new OpsStore(kv, 'acc', 'Studio');
    store.update((draft) => void (draft.settings.queuePrefix = 'B'));
    kv.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(() => store.update((draft) => void (draft.settings.queuePrefix = 'C'))).toThrow('Penyimpanan perangkat ini penuh');
    expect(store.state.settings.queuePrefix).toBe('B');
  });
});

describe('qrisHandler', () => {
  it('starts empty and keeps the damaged file when its state is unreadable', async () => {
    // The app's own code never touches the disk, so src has no Node types: load these untyped.
    const node = (name: string) => import(/* @vite-ignore */ name);
    const [fs, os, path] = await Promise.all([node('node:fs'), node('node:os'), node('node:path')]);
    const folder: string = fs.mkdtempSync(path.join(os.tmpdir(), 'qris-'));
    const file: string = path.join(folder, 'qris.json');
    fs.writeFileSync(file, '{"token":"abc","charg');
    qrisHandler(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toHaveLength(48);
    const names: string[] = fs.readdirSync(folder);
    expect(names.filter((name) => name.startsWith('qris.json.damaged-'))).toHaveLength(1);
    expect(names).not.toContain('qris.json.tmp');
  });
});

describe('OpsStore records', () => {
  const account = { id: 'acc', business: 'Studio', createdAt: 0 };

  function counting() {
    const kv = memoryStore();
    const written: string[] = [];
    const setItem = kv.setItem.bind(kv);
    kv.setItem = (key, value) => {
      written.push(key);
      setItem(key, value);
    };
    return { kv, written };
  }

  it('saves a change as the records it touched, not the whole history', async () => {
    const { Ops } = await import('./ops');
    const { kv, written } = counting();
    (globalThis as { localStorage?: unknown }).localStorage = memoryStore();
    const store = new OpsStore(kv, account.id, account.business, () => Date.UTC(2026, 10, 1, 3));
    const ops = new Ops(store, account, { toast: () => {}, devicePointId: () => 'k1' });
    ops.sites = { locations: [{ id: 'mall', name: 'DB', city: 'Bandung', address: '', createdAt: 0 }], points: [{ id: 'k1', locationId: 'mall', name: 'Booth 1', code: 'B1', active: true, createdAt: 0 }] };
    ops.openShift('mall', 0);
    const sell = () => {
      const order = ops.createOrder({ lines: [{ kind: 'session', refId: 'photobox', label: 'Photo strip', unitPrice: 35_000, qty: 1, mode: 'strip' }], presetId: null, voucherCode: '', channel: 'cashier', branchId: 'mall', boothId: null });
      ops.pay(order.id, 'cash', 35_000);
    };
    for (let n = 0; n < 50; n += 1) sell();
    written.length = 0;
    sell();
    const records = written.filter((key) => key.includes(':rec:'));
    // A sale is three saves (create, pay, finish). Each writes the new order and the few records
    // around it, never the 50 orders before it.
    expect(new Set(records.filter((key) => key.includes(':rec:orders:'))).size).toBe(1);
    expect(records.length).toBeLessThan(20);

    // A fresh store on the same disk reads back exactly what the first one holds.
    const again = new OpsStore(kv, account.id, account.business);
    expect(again.state).toEqual(store.state);
    expect(again.state.orders).toHaveLength(51);
  });

  it('rewrites only the last chunk of a long list when a record is added', () => {
    const { kv, written } = counting();
    const store = new OpsStore(kv, 'acc', 'Studio');
    const voucher = (n: number) => ({ id: `v${n}`, code: `C${n}` }) as never;
    store.update((draft) => {
      for (let n = 0; n < 1200; n += 1) draft.vouchers.unshift(voucher(n));
    });
    written.length = 0;
    store.update((draft) => void draft.vouchers.unshift(voucher(1200)));
    expect(written.filter((key) => key.includes(':list:vouchers'))).toEqual(['vto:ops:acc:list:vouchers:2']);
    // Taking one out of the middle rewrites from that chunk on, and the order survives a reload.
    store.update((draft) => {
      draft.vouchers = draft.vouchers.filter((entry) => entry.id !== 'v700');
    });
    const again = new OpsStore(kv, 'acc', 'Studio');
    expect(again.state.vouchers.map((entry) => entry.id)).toEqual(store.state.vouchers.map((entry) => entry.id));
    expect(again.state.vouchers).toHaveLength(1200);
    expect(again.state.vouchers[0].id).toBe('v1200');
    expect(kv.getItem('vto:ops:acc:rec:vouchers:v700')).toBeNull();
  });

  it('splits a workspace saved as one document, keeping every record', () => {
    const kv = memoryStore();
    const old = new OpsStore(memoryStore(), 'acc', 'Studio').state;
    const legacy = { ...old, orders: [{ id: 'o1', number: 'INV-1' }], activity: [{ id: 'a1', at: 1, kind: 'order.create', message: 'x', staffId: null, branchId: null }] };
    kv.setItem('vto:ops:acc', JSON.stringify(legacy));
    const store = new OpsStore(kv, 'acc', 'Studio');
    expect(store.state.orders).toEqual([{ id: 'o1', number: 'INV-1' }]);
    expect(JSON.parse(kv.getItem('vto:ops:acc')!).format).toBe(2);
    expect(kv.getItem('vto:ops:acc:list:orders')).toBe('1');
    expect(JSON.parse(kv.getItem('vto:ops:acc:list:orders:0')!)).toEqual(['o1']);
    expect(new OpsStore(kv, 'acc', 'Studio').state.activity).toEqual(legacy.activity);
  });

  it('brings new and changed records to another window', () => {
    const windows: Array<{ postMessage(writes: unknown): void; onmessage: ((event: { data: never }) => void) | null }> = [];
    const channel = () => {
      const mine = { onmessage: null, postMessage: (data: unknown) => windows.filter((other) => other !== mine).forEach((other) => other.onmessage?.({ data: data as never })) };
      windows.push(mine);
      return mine;
    };
    const backing: Backing = { load: async () => [], write: async () => {} };
    const till = new OpsStore(cachedStore([], backing, { channel: channel() }), 'acc', 'Studio');
    const tv = new OpsStore(cachedStore([], backing, { channel: channel() }), 'acc', 'Studio');
    till.update((draft) => void draft.tickets.push({ id: 't1', number: 'A001', status: 'waiting' } as never));
    till.update((draft) => void draft.tickets.push({ id: 't2', number: 'A002', status: 'waiting' } as never));
    till.update((draft) => void (draft.tickets.find((ticket) => ticket.id === 't1')!.status = 'called'));
    expect(tv.state.tickets.map((ticket) => [ticket.id, ticket.status])).toEqual([['t1', 'called'], ['t2', 'waiting']]);
    // Records nobody touched keep their identity in the other window too.
    const second = tv.state.tickets[1];
    till.update((draft) => void (draft.tickets[0].status = 'done'));
    expect(tv.state.tickets[1]).toBe(second);
    expect(tv.state.activity).toEqual(till.state.activity);
  });
});
