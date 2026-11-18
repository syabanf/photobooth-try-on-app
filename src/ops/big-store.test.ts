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
    async put(key, value) {
      if (full) throw new Error('QuotaExceededError');
      writes.push(key);
      saved.set(key, value);
    },
    remove: async (key) => void saved.delete(key),
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
    const windows: Array<{ postMessage(change: unknown): void; onmessage: ((event: { data: never }) => void) | null }> = [];
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
    expect(() => store.update((draft) => void (draft.settings.queuePrefix = 'C'))).toThrow('storage is full');
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
