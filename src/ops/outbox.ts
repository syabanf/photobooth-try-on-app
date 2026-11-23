// The offline session queue. Every sale, session and refund is written here first and only leaves
// once the cloud acknowledges it, so a booth that loses its connection loses nothing. Items keep
// their order: a failure stops the flush, and the next flush retries from the same item.

import type { KeyValueStore } from '../account/backend';

export interface OutboxItem {
  /** Also the idempotency key: the cloud ignores an id it already has. */
  id: string;
  kind: string;
  payload: unknown;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
}

export type Transport = (item: OutboxItem) => Promise<void>;

const MAX_BACKOFF_MS = 5 * 60_000;

/** 2 s, 4 s, 8 s … capped at 5 minutes. */
export const backoff = (attempts: number) => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts);

export class Outbox {
  private flushing: Promise<number> | null = null;
  /** The last text read or written and its items, so an unchanged queue is not parsed again. */
  private cache: { raw: string; items: OutboxItem[] } | null = null;

  constructor(
    private readonly store: KeyValueStore,
    private readonly key: string,
    private readonly send: Transport,
    private readonly now: () => number = Date.now,
  ) {}

  pending(): OutboxItem[] {
    const raw = this.store.getItem(this.key) ?? '[]';
    if (this.cache?.raw !== raw) {
      try {
        this.cache = { raw, items: JSON.parse(raw) as OutboxItem[] };
      } catch {
        this.cache = { raw, items: [] };
      }
    }
    // A copy, so a caller that changes the list cannot change the cache.
    return [...this.cache.items];
  }

  private save(items: OutboxItem[]): void {
    const raw = JSON.stringify(items);
    this.store.setItem(this.key, raw);
    this.cache = { raw, items };
  }

  /** Persists before returning, so a crash right after a sale still has it on disk. */
  enqueue(id: string, kind: string, payload: unknown): void {
    const items = this.pending();
    if (items.some((item) => item.id === id)) return;
    items.push({ id, kind, payload, createdAt: this.now(), attempts: 0, nextAttemptAt: 0, lastError: '' });
    this.save(items);
  }

  /** Sends due items in order. Resolves with how many went through. */
  flush(): Promise<number> {
    this.flushing ??= this.run().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async run(): Promise<number> {
    let sent = 0;
    for (;;) {
      const [head] = this.pending();
      if (!head || head.nextAttemptAt > this.now()) return sent;
      try {
        await this.send(head);
        this.save(this.pending().filter((item) => item.id !== head.id));
        sent += 1;
      } catch (error) {
        const attempts = head.attempts + 1;
        const failed = { ...head, attempts, nextAttemptAt: this.now() + backoff(attempts), lastError: String((error as Error)?.message ?? error) };
        this.save(this.pending().map((item) => (item.id === head.id ? failed : item)));
        return sent;
      }
    }
  }

  /** Clears the backoff, for a reconnect or a manual "Sync now". */
  retryNow(): Promise<number> {
    this.save(this.pending().map((item) => ({ ...item, nextAttemptAt: 0 })));
    return this.flush();
  }
}
