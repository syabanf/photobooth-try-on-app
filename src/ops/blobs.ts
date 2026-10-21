// Pictures and clips the business uploads (frames, the logo, ads), kept in IndexedDB by id.

const DB_NAME = 'vto-ops';
const STORE = 'blobs';

let database: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, Blob>();
const urls = new Map<string, string>();

function open(): Promise<IDBDatabase | null> {
  database ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return database;
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = work(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putBlob(blob: Blob): Promise<string> {
  const id = crypto.randomUUID();
  const db = await open();
  if (db) await run(db, 'readwrite', (store) => store.put(blob, id));
  else memory.set(id, blob);
  return id;
}

async function getBlob(id: string): Promise<Blob | null> {
  if (!id) return null;
  const db = await open();
  return (db ? await run<Blob | undefined>(db, 'readonly', (store) => store.get(id)) : memory.get(id)) ?? null;
}

export async function deleteBlob(id: string): Promise<void> {
  if (!id) return;
  const db = await open();
  if (db) await run(db, 'readwrite', (store) => store.delete(id));
  memory.delete(id);
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
}

/** An object URL for a stored blob, made once and reused by every page that shows it. */
export async function blobUrl(id: string): Promise<string> {
  if (!id) return '';
  const cached = urls.get(id);
  if (cached) return cached;
  const blob = await getBlob(id);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  urls.set(id, url);
  return url;
}
