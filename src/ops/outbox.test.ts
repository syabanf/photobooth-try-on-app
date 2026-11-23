import { describe, expect, it } from 'vitest';
import { memoryStore } from '../account/backend';
import { Outbox } from './outbox';

describe('Outbox', () => {
  it('parses the queue once and still sees another window\'s writes', async () => {
    const kv = memoryStore();
    let parses = 0;
    const parse = JSON.parse;
    JSON.parse = (text: string) => (parses++, parse(text));
    try {
      const sent: string[] = [];
      const outbox = new Outbox(kv, 'q', async (item) => void sent.push(item.id));
      outbox.enqueue('a', 'order.pay', {});
      outbox.enqueue('b', 'order.pay', {});
      outbox.pending();
      outbox.pending();
      expect(parses).toBe(1);
      // A second till appends to the same queue.
      kv.setItem('q', JSON.stringify([...outbox.pending(), { id: 'c', kind: 'x', payload: {}, createdAt: 0, attempts: 0, nextAttemptAt: 0, lastError: '' }]));
      expect(outbox.pending().map((item) => item.id)).toEqual(['a', 'b', 'c']);
      await outbox.flush();
      expect(sent).toEqual(['a', 'b', 'c']);
      expect(outbox.pending()).toEqual([]);
    } finally {
      JSON.parse = parse;
    }
  });
});
