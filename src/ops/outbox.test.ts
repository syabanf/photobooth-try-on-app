import { describe, expect, it } from 'vitest';
import { memoryStore } from '../account/backend';
import { Outbox, type OutboxItem } from './outbox';

const item = (id: string): OutboxItem => ({ id, kind: 'order.pay', payload: {}, createdAt: 0, attempts: 0, nextAttemptAt: 0, lastError: '' });

describe('Outbox', () => {
  it('queues each item under its own key, so a long backlog costs one small write', () => {
    const kv = memoryStore();
    const written: string[] = [];
    const setItem = kv.setItem.bind(kv);
    kv.setItem = (key, value) => {
      written.push(key);
      setItem(key, value);
    };
    const outbox = new Outbox(kv, 'q', async () => {});
    for (let n = 0; n < 100; n += 1) outbox.enqueue(`i${n}`, 'order.pay', { n });
    written.length = 0;
    outbox.enqueue('last', 'order.pay', {});
    expect(written).toEqual(['q:item:last', 'q']);
    expect(outbox.size()).toBe(101);
  });

  it('sends in order and sees items another window queued', async () => {
    const kv = memoryStore();
    const sent: string[] = [];
    const outbox = new Outbox(kv, 'q', async (entry) => void sent.push(entry.id));
    outbox.enqueue('a', 'order.pay', {});
    outbox.enqueue('b', 'order.pay', {});
    // A second till on this browser appends to the same queue.
    new Outbox(kv, 'q', async () => {}).enqueue('c', 'order.pay', {});
    expect(outbox.pending().map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    await outbox.flush();
    expect(sent).toEqual(['a', 'b', 'c']);
    expect(outbox.size()).toBe(0);
    expect(kv.getItem('q:item:a')).toBeNull();
  });

  it('upgrades a queue saved as one array by an earlier build', async () => {
    const kv = memoryStore();
    kv.setItem('q', JSON.stringify([item('old1'), item('old2')]));
    const sent: string[] = [];
    const outbox = new Outbox(kv, 'q', async (entry) => void sent.push(entry.id));
    expect(outbox.size()).toBe(2);
    expect(JSON.parse(kv.getItem('q')!)).toEqual(['old1', 'old2']);
    await outbox.flush();
    expect(sent).toEqual(['old1', 'old2']);
  });
});
