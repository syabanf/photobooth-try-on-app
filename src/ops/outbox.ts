// The offline session queue. Every sale, session and refund is written here first and only leaves
// once the cloud acknowledges it, so a booth that loses its connection loses nothing. Items keep
// their order: a failure stops the flush, and the next flush retries from the same item.
//
// Each item has its own key and the queue key holds only the ids in order, so queueing a sale
// while offline writes one small item, however long the backlog has grown.

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

function parse<T>(raw: string | null): T | null {
  try {
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export class Outbox {
  private flushing: Promise<number> | null = null;
  /** The ids as last read or written, so an unchanged queue is not parsed again. */
  private cache: { raw: string; ids: string[] } | null = null;

  constructor(
    private readonly store: KeyValueStore,
    private readonly key: string,
    private readonly send: Transport,
    private readonly now: () => number = Date.now,
  ) {}

  private itemKey(id: string): string {
    return `${this.key}:item:${id}`;
  }

  private ids(): string[] {
    const raw = this.store.getItem(this.key) ?? '[]';
    if (this.cache?.raw === raw) return this.cache.ids;
    const saved = parse<Array<string | OutboxItem>>(raw) ?? [];
    // Builds before this one kept whole items in the queue key: give each its own key once.
    if (saved.some((entry) => typeof entry !== 'string')) {
      const items = saved.filter((entry): entry is OutboxItem => typeof entry === 'object' && entry !== null);
      for (const item of items) this.saveItem(item);
      this.saveIds(items.map((item) => item.id));
      return this.cache!.ids;
    }
    this.cache = { raw, ids: saved as string[] };
    return this.cache.ids;
  }

  private saveIds(ids: string[]): void {
    const raw = JSON.stringify(ids);
    this.store.setItem(this.key, raw);
    this.cache = { raw, ids };
  }

  private item(id: string): OutboxItem | null {
    return parse<OutboxItem>(this.store.getItem(this.itemKey(id)));
  }

  private saveItem(item: OutboxItem): void {
    this.store.setItem(this.itemKey(item.id), JSON.stringify(item));
  }

  /** How many items wait, without reading them. */
  size(): number {
    return this.ids().length;
  }

  pending(): OutboxItem[] {
    return this.ids().map((id) => this.item(id)).filter((item): item is OutboxItem => item !== null);
  }

  /** Persists before returning, so a crash right after a sale still has it on disk. */
  enqueue(id: string, kind: string, payload: unknown): void {
    const ids = this.ids();
    if (ids.includes(id)) return;
    // The item lands before its id, so a reader never meets an id without its item.
    this.saveItem({ id, kind, payload, createdAt: this.now(), attempts: 0, nextAttemptAt: 0, lastError: '' });
    this.saveIds([...ids, id]);
  }

  /** Sends due items in order. Resolves with how many went through. */
  flush(): Promise<number> {
    this.flushing ??= this.run().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private drop(id: string): void {
    this.saveIds(this.ids().filter((other) => other !== id));
    this.store.removeItem(this.itemKey(id));
  }

  private async run(): Promise<number> {
    let sent = 0;
    for (;;) {
      const [id] = this.ids();
      if (!id) return sent;
      const head = this.item(id);
      if (!head) {
        this.drop(id);
        continue;
      }
      if (head.nextAttemptAt > this.now()) return sent;
      try {
        await this.send(head);
        this.drop(head.id);
        sent += 1;
      } catch (error) {
        const attempts = head.attempts + 1;
        this.saveItem({ ...head, attempts, nextAttemptAt: this.now() + backoff(attempts), lastError: String((error as Error)?.message ?? error) });
        return sent;
      }
    }
  }

  /** Clears the backoff, for a reconnect or a manual "Sync now". */
  retryNow(): Promise<number> {
    for (const item of this.pending()) if (item.nextAttemptAt) this.saveItem({ ...item, nextAttemptAt: 0 });
    return this.flush();
  }
}
