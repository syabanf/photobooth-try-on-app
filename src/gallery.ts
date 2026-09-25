// Saved captures, kept in IndexedDB so they survive a reload. Falls back to memory when the
// browser refuses storage, as private windows can.

import type { BoothLayout } from './photobooth';

export type ShotKind = 'photobooth' | 'snapshot';

export interface Shot {
  id: string;
  kind: ShotKind;
  layout: BoothLayout | null;
  createdAt: number;
  blob: Blob;
  /** The point the device ran as. Missing on shots saved before points existed. */
  pointId?: string | null;
}

const DB_NAME = 'virtual-try-on';
const STORE = 'shots';

let database: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, Shot>();

function openDatabase(): Promise<IDBDatabase | null> {
  database ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
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

export async function saveShot(
  blob: Blob,
  kind: ShotKind,
  pointId: string | null,
  layout: BoothLayout | null = null,
): Promise<Shot> {
  const shot: Shot = { id: crypto.randomUUID(), kind, layout, createdAt: Date.now(), blob, pointId };
  const db = await openDatabase();
  if (db) await run(db, 'readwrite', (store) => store.put(shot));
  else memory.set(shot.id, shot);
  return shot;
}

/** Newest first. */
export async function listShots(): Promise<Shot[]> {
  const db = await openDatabase();
  const shots = db ? await run<Shot[]>(db, 'readonly', (store) => store.getAll()) : [...memory.values()];
  return shots.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteShot(id: string): Promise<void> {
  const db = await openDatabase();
  if (db) await run(db, 'readwrite', (store) => store.delete(id));
  else memory.delete(id);
}

export async function countByPoint(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const shot of await listShots()) {
    if (shot.pointId) counts.set(shot.pointId, (counts.get(shot.pointId) ?? 0) + 1);
  }
  return counts;
}
