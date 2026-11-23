// Where the business records live: IndexedDB, read through the synchronous KeyValueStore the app
// already uses. localStorage stops at about 5 MB, which a busy booth fills in a few thousand sales.
//
// Every value is loaded into memory once at start, so reads stay synchronous. A write lands in
// memory at once, goes to the disk in the background, and reaches the other windows of this
// browser (the customer screen, the queue TV) through a BroadcastChannel.

import { browserStore, type KeyValueStore } from '../account/backend';

/** The disk under the cache. IndexedDB in the browser; a fake in tests. */
export interface Backing {
  load(): Promise<Array<[string, string]>>;
  put(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

type Change = { key: string; value: string | null };
type Channel = { postMessage(change: Change): void; onmessage: ((event: { data: Change }) => void) | null };

export interface CachedStoreOptions {
  /** Where these records lived before. A key found only there moves over on first read. */
  legacy?: KeyValueStore | null;
  channel?: Channel | null;
  /** Called when the disk refuses a write. The value stays in memory and the next write retries it. */
  onFailure?: (error: Error) => void;
}

export function cachedStore(entries: Array<[string, string]>, backing: Backing, { legacy = null, channel = null, onFailure = () => {} }: CachedStoreOptions = {}): Required<KeyValueStore> {
  const cache = new Map(entries);
  const watchers = new Map<string, Set<() => void>>();
  /** What still has to reach the disk. A key written twice before its turn goes out once. */
  const pending = new Map<string, string | null>();
  let writing = false;

  async function flush(): Promise<void> {
    if (writing) return;
    writing = true;
    try {
      for (const [key, value] of pending) {
        pending.delete(key);
        try {
          await (value === null ? backing.remove(key) : backing.put(key, value));
          legacy?.removeItem(key);
        } catch (error) {
          if (!pending.has(key)) pending.set(key, value);
          onFailure(error as Error);
          return;
        }
      }
    } finally {
      writing = false;
    }
  }

  function write(key: string, value: string | null): void {
    if (value === null) cache.delete(key);
    else cache.set(key, value);
    pending.set(key, value);
    void flush();
  }

  if (channel) {
    channel.onmessage = ({ data: { key, value } }) => {
      if (value === null) cache.delete(key);
      else cache.set(key, value);
      for (const listener of watchers.get(key) ?? []) listener();
    };
  }

  return {
    getItem(key) {
      const value = cache.get(key);
      if (value !== undefined) return value;
      const old = legacy?.getItem(key) ?? null;
      if (old !== null) write(key, old);
      return old;
    },
    setItem(key, value) {
      write(key, value);
      channel?.postMessage({ key, value });
    },
    removeItem(key) {
      write(key, null);
      channel?.postMessage({ key, value: null });
    },
    watch(key, listener) {
      if (!watchers.has(key)) watchers.set(key, new Set());
      watchers.get(key)!.add(listener);
    },
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
    put: (key, value) => run('readwrite', (store) => void store.put(value, key)),
    remove: (key) => run('readwrite', (store) => void store.delete(key)),
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
