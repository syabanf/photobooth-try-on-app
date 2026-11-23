// Where the business records live: IndexedDB, read through the synchronous KeyValueStore the app
// already uses. localStorage stops at about 5 MB, which a busy booth fills in a few thousand sales.
//
// Every value is loaded into memory once at start, so reads stay synchronous. A write lands in
// memory at once, goes to the disk in the background, and reaches the other windows of this
// browser (the customer screen, the queue TV) through a BroadcastChannel.

import { browserStore, type KeyValueStore, type KeyWrite } from '../account/backend';

/** The disk under the cache. IndexedDB in the browser; a fake in tests. */
export interface Backing {
  load(): Promise<Array<[string, string]>>;
  /** Saves several keys in one transaction; `null` removes a key. */
  write(writes: readonly KeyWrite[]): Promise<void>;
}

type Channel = { postMessage(writes: readonly KeyWrite[]): void; onmessage: ((event: { data: readonly KeyWrite[] }) => void) | null };

export interface CachedStoreOptions {
  /** Where these records lived before. A key found only there moves over on first read. */
  legacy?: KeyValueStore | null;
  channel?: Channel | null;
  /** Called when the disk refuses a write. The value stays in memory and the next write retries it. */
  onFailure?: (error: Error) => void;
}

export function cachedStore(entries: Array<[string, string]>, backing: Backing, { legacy = null, channel = null, onFailure = () => {} }: CachedStoreOptions = {}): Required<KeyValueStore> {
  const cache = new Map(entries);
  const listeners = new Set<(writes: readonly KeyWrite[]) => void>();
  /** What still has to reach the disk. A key written twice before its turn goes out once. */
  const pending = new Map<string, string | null>();
  let writing = false;

  async function flush(): Promise<void> {
    if (writing) return;
    writing = true;
    try {
      while (pending.size) {
        const batch = [...pending];
        pending.clear();
        try {
          await backing.write(batch);
          for (const [key] of batch) legacy?.removeItem(key);
        } catch (error) {
          // Put back what no newer write replaced, and wait for the next write to try again.
          for (const [key, value] of batch) if (!pending.has(key)) pending.set(key, value);
          onFailure(error as Error);
          return;
        }
      }
    } finally {
      writing = false;
    }
  }

  function apply(writes: readonly KeyWrite[]): void {
    for (const [key, value] of writes) {
      if (value === null) cache.delete(key);
      else cache.set(key, value);
    }
  }

  function batch(writes: readonly KeyWrite[]): void {
    if (writes.length === 0) return;
    apply(writes);
    for (const [key, value] of writes) pending.set(key, value);
    void flush();
    channel?.postMessage(writes);
  }

  if (channel) {
    channel.onmessage = ({ data }) => {
      apply(data);
      for (const listener of listeners) listener(data);
    };
  }

  return {
    getItem(key) {
      const value = cache.get(key);
      if (value !== undefined) return value;
      const old = legacy?.getItem(key) ?? null;
      if (old !== null) {
        cache.set(key, old);
        pending.set(key, old);
        void flush();
      }
      return old;
    },
    setItem: (key, value) => batch([[key, value]]),
    removeItem: (key) => batch([[key, null]]),
    batch,
    onRemote: (listener) => void listeners.add(listener),
  };
}

const DB_NAME = 'vto-records';
const STORE = 'kv';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function indexedDbBacking(db: IDBDatabase): Backing {
  /** Resolves once the transaction is on the disk, not when the request is merely accepted. */
  const run = <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => T): Promise<T> =>
    new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode, { durability: 'strict' });
      const result = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Browser menolak menyimpan.'));
    });
  return {
    async load() {
      const { keys, values } = await run('readonly', (store) => ({ keys: store.getAllKeys(), values: store.getAll() }));
      return keys.result.map((key, index) => [String(key), values.result[index] as string]);
    },
    write: (writes) =>
      run('readwrite', (store) => {
        for (const [key, value] of writes) {
          if (value === null) store.delete(key);
          else store.put(value, key);
        }
      }),
  };
}

let opened: Promise<KeyValueStore> | null = null;

/**
 * The store for business records, opened once per page. Falls back to localStorage where the
 * browser has no IndexedDB (some private windows), with its 5 MB limit.
 */
export function openRecords(onFailure: (error: Error) => void): Promise<KeyValueStore> {
  opened ??= (async () => {
    const legacy = browserStore();
    try {
      const backing = indexedDbBacking(await openDatabase());
      // Without this the browser may clear the records when the disk runs low.
      void navigator.storage?.persist?.();
      return cachedStore(await backing.load(), backing, { legacy, channel: new BroadcastChannel('vto:records') as unknown as Channel, onFailure });
    } catch {
      return legacy;
    }
  })();
  return opened;
}
