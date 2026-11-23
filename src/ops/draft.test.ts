import { describe, expect, it } from 'vitest';
import { produce } from './draft';

const state = () => ({
  orders: [
    { id: 'a', status: 'open', payments: [{ id: 'p1', status: 'pending' }] },
    { id: 'b', status: 'paid', payments: [] as { id: string; status: string }[] },
  ],
  settings: { prefix: 'A', limits: { max: 3 } },
  activity: [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
});

describe('produce', () => {
  it('copies only what the change writes and leaves the base alone', () => {
    const base = state();
    const before = JSON.stringify(base);
    const next = produce(base, (draft) => {
      draft.orders.find((order) => order.id === 'a')!.payments[0].status = 'paid';
    });
    expect(JSON.stringify(base)).toBe(before);
    expect(next.orders[0].payments[0].status).toBe('paid');
    expect(next.orders).not.toBe(base.orders);
    expect(next.orders[0]).not.toBe(base.orders[0]);
    expect(next.orders[1]).toBe(base.orders[1]);
    expect(next.settings).toBe(base.settings);
    expect(next.activity).toBe(base.activity);
  });

  it('returns the base itself when nothing changes', () => {
    const base = state();
    expect(produce(base, (draft) => void draft.orders.find((order) => order.id === 'b'))).toBe(base);
    expect(produce(base, (draft) => void (draft.settings.prefix = 'A'))).toBe(base);
  });

  it('handles the array edits the business code uses', () => {
    const base = state();
    const next = produce(base, (draft) => {
      draft.activity.unshift({ id: 'new' });
      draft.activity.length = 3;
      draft.orders.push({ id: 'c', status: 'open', payments: [] });
      draft.orders.splice(1, 1);
      draft.orders.sort((left, right) => right.id.localeCompare(left.id));
    });
    expect(next.activity.map((entry) => entry.id)).toEqual(['new', 'x', 'y']);
    expect(next.activity[1]).toBe(base.activity[0]);
    expect(next.orders.map((order) => order.id)).toEqual(['c', 'a']);
    expect(next.orders[1]).toBe(base.orders[0]);
    expect(base.orders.map((order) => order.id)).toEqual(['a', 'b']);
  });

  it('resolves drafts placed inside new objects', () => {
    const base = state();
    const next = produce(base, (draft) => {
      const open = draft.orders.filter((order) => order.status === 'open');
      open[0].status = 'held';
      (draft as unknown as { held: unknown }).held = { orders: open, note: { list: [draft.settings.limits] } };
    });
    const held = (next as unknown as { held: { orders: unknown[]; note: { list: unknown[] } } }).held;
    expect(held.orders[0]).toBe(next.orders[0]);
    expect(held.orders[0]).toMatchObject({ status: 'held' });
    expect(held.note.list[0]).toBe(base.settings.limits);
    // The result is plain data: it survives JSON and structuredClone.
    expect(structuredClone(next)).toEqual(JSON.parse(JSON.stringify(next)));
  });

  it('lets a change read what it just wrote', () => {
    const next = produce(state(), (draft) => {
      draft.settings.limits.max += 1;
      draft.settings.limits.max += 1;
      draft.orders[0].payments.push({ id: 'p2', status: 'paid' });
      expect(draft.orders[0].payments.map((payment) => payment.id)).toEqual(['p1', 'p2']);
      expect(Object.keys(draft.settings)).toEqual(['prefix', 'limits']);
      delete (draft.settings as Partial<typeof draft.settings>).prefix;
      expect('prefix' in draft.settings).toBe(false);
    });
    expect(next.settings).toEqual({ limits: { max: 5 } });
  });

  it('lets a search see what the change already wrote, nested or not', () => {
    const base = state();
    const next = produce(base, (draft) => {
      draft.orders[0].payments[0].status = 'paid';
      draft.orders[1].status = 'void';
      expect(draft.orders.some((order) => order.payments.some((payment) => payment.status === 'pending'))).toBe(false);
      expect(draft.orders.filter((order) => order.status === 'void').map((order) => order.id)).toEqual(['b']);
      // What a search returns is a draft, so writing to it is saved.
      draft.orders.find((order) => order.id === 'b')!.status = 'refunded';
    });
    expect(next.orders[1].status).toBe('refunded');
    expect(base.orders[1].status).toBe('paid');
  });

  it('leaves the base untouched when the change throws', () => {
    const base = state();
    const before = JSON.stringify(base);
    expect(() => produce(base, (draft) => {
      draft.orders[0].status = 'paid';
      throw new Error('nope');
    })).toThrow('nope');
    expect(JSON.stringify(base)).toBe(before);
  });
});
