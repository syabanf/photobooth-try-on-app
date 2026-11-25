// The business store. The workspace lives in memory as one state object; on disk the lists that
// grow with every sale (orders, tickets, vouchers, the activity log …) keep one key per record and
// the rest shares one small document, so a sale writes the handful of records it touched instead
// of the whole history. Changes go through copy-on-write drafts (draft.ts), which is how the store
// knows what was touched. Other windows (the customer screen, the queue TV) receive the same
// records and patch their state. Storage is IndexedDB (big-store.ts), or localStorage where the
// browser has no IndexedDB. Pictures (frames, logo, ads) live in IndexedDB through blobs.ts.

import type { KeyValueStore, KeyWrite } from '../account/backend';
import { produce } from './draft';
import { uuid } from '../uuid';
import type { ActivityEntry, Branding, OpsState, Preset, Settings } from './model';
import { DEFAULT_PAYMENTS, withPaymentDefaults } from './payments';

const DEFAULT_BRANDING: Branding = {
  brandName: '',
  logo: '',
  accent: '#f04e30',
  ink: '#101112',
  background: '#f1f0f1',
  welcome: 'Sentuh untuk mulai',
  thanks: 'Pindai untuk ambil foto Anda',
  instagram: '',
  tiktok: '',
  website: '',
  customDomain: '',
};

const DEFAULT_SETTINGS: Settings = {
  shiftsEnabled: true,
  retentionDays: 30,
  payments: DEFAULT_PAYMENTS,
  idleSeconds: 60,
  adsEnabled: false,
  receiptFooter: 'Terima kasih! Tunjukkan struk ini di booth.',
  queuePrefix: 'A',
  faceLibrary: 'all',
  presetPrice: 25_000,
  rolePermissions: {},
};

const preset = (id: string, name: string, layout: Preset['layout'], prompt: string): Preset => ({ id, name, layout, prompt, frameId: null, active: true, builtIn: true });

/** The templates every workspace starts with. Owners edit their prompts and add their own. */
export const BUILT_IN_PRESETS: Preset[] = [
  preset('cover', 'Sampul majalah', 'cover', 'Restyle as a glossy fashion magazine cover shot: studio lighting, crisp skin detail, bold editorial colour grade, sharp focus on the face.'),
  preset('polaroid', 'Polaroid', 'polaroid', 'Make this a real instant-film photo: soft flash, warm faded colours, light grain and gentle vignette, like a candid party snapshot.'),
  preset('poster', 'Poster film', 'poster', 'Turn this into a cinematic movie poster: dramatic rim light, teal and orange grade, haze in the background, the person as the lead star.'),
  preset('pass', 'Kartu VIP', 'pass', 'Make this a premium event VIP pass photo: clean studio portrait, even soft light, neutral backdrop, printed on glossy card stock.'),
  preset('squad', 'Squad', 'squad', 'Make this a fun group photo collage with matching bright studio light and colour, every face sharp and natural, like a team poster.'),
];

/**
 * A starting price list so a new workspace can sell straight away. Every number is editable in
 * Settings and nothing here is a record of a real sale.
 */
function starter(business: string, ownerId: string): OpsState {
  return {
    version: 1,
    categories: [{ id: 'photobox', name: 'Photobox', prices: { strip: 35_000, gif: 30_000, video: 40_000, live: 35_000, vintage: 40_000 } }],
    printPrices: [
      { size: '2R', price: 10_000 },
      { size: '4R', price: 15_000 },
      { size: '6R', price: 25_000 },
      { size: 'A4', price: 40_000 },
    ],
    products: [],
    presets: [],
    booths: [],
    vouchers: [],
    orders: [],
    refunds: [],
    shifts: [],
    sessions: [],
    events: [],
    tickets: [],
    printers: [],
    cameras: [],
    health: [],
    alerts: [],
    rules: [],
    notifications: [],
    staff: [{ id: ownerId, name: 'Owner', role: 'owner', branchIds: [], pinHash: '', pinSalt: '', email: '', phone: '', onDuty: true, active: true }],
    frames: [],
    faces: [],
    aiPresets: BUILT_IN_PRESETS.map((entry) => ({ ...entry })),
    branding: { ...DEFAULT_BRANDING, brandName: business },
    ads: [],
    activity: [],
    settings: { ...DEFAULT_SETTINGS },
    counters: { order: 0, ticket: 0 },
  };
}

/** The log keeps the newest entries; the cloud has the rest once synced. */
export const ACTIVITY_LIMIT = 2000;

export type Listener = (state: OpsState) => void;

/** The lists that grow with use. Each record is saved under its own key. */
const RECORD_FIELDS = ['orders', 'tickets', 'vouchers', 'sessions', 'refunds', 'shifts', 'alerts', 'notifications', 'faces', 'activity'] as const;
type RecordField = (typeof RECORD_FIELDS)[number];
type Stored = { id: string };
/** Ids per saved chunk of a list. */
const CHUNK = 500;
const isRecordField = (key: string): key is RecordField => (RECORD_FIELDS as readonly string[]).includes(key);

function parse<T>(raw: string | null): T | null {
  try {
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export class OpsStore {
  state: OpsState;
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  /** Changes with every save from any window, so a store can tell another window wrote. */
  private rev: string | null;
  /** True once the disk holds every record under its own key; until then a save writes them all. */
  private split = false;
  readonly key: string;

  constructor(
    readonly kv: KeyValueStore,
    readonly accountId: string,
    business: string,
    readonly now: () => number = Date.now,
  ) {
    this.key = `vto:ops:${accountId}`;
    this.rev = kv.getItem(this.revKey);
    this.state = this.load() ?? starter(business, `owner-${accountId}`);
    if (kv.onRemote) {
      kv.onRemote((writes) => this.patch(writes));
      return;
    }
    try {
      this.channel = new BroadcastChannel(this.key);
      this.channel.onmessage = () => this.reload();
    } catch {
      // No BroadcastChannel (old browser, tests): other windows only refresh on reload.
    }
  }

  private get revKey(): string {
    return `${this.key}:rev`;
  }

  /** How many chunks a list has. */
  private listKey(field: RecordField): string {
    return `${this.key}:list:${field}`;
  }

  private chunkKey(field: RecordField, index: number): string {
    return `${this.key}:list:${field}:${index}`;
  }

  /** A list's ids, newest first as the business code keeps them. */
  private readIds(field: RecordField): string[] {
    const count = parse<number>(this.kv.getItem(this.listKey(field))) ?? 0;
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) ids.push(...(parse<string[]>(this.kv.getItem(this.chunkKey(field, index))) ?? []));
    return ids.reverse();
  }

  /**
   * The chunks of a list that differ from before. On disk a list runs oldest first: new records,
   * which the business code puts at the front, land in the last chunk, so a sale rewrites one
   * chunk of at most CHUNK ids instead of every id the workspace ever made.
   */
  private listWrites(field: RecordField, before: readonly Stored[] | null, after: readonly Stored[], unchanged = 0): KeyWrite[] {
    // `unchanged` ids at the old end match, so the chunks they fill stay as they are.
    const count = Math.ceil(after.length / CHUNK);
    const previousCount = before ? Math.ceil(before.length / CHUNK) : -1;
    const writes: KeyWrite[] = [];
    for (let index = Math.floor(unchanged / CHUNK); index < count; index += 1) {
      const ids: string[] = [];
      for (let at = index * CHUNK; at < Math.min((index + 1) * CHUNK, after.length); at += 1) ids.push(after[after.length - 1 - at].id);
      writes.push([this.chunkKey(field, index), JSON.stringify(ids)]);
    }
    for (let index = count; index < previousCount; index += 1) writes.push([this.chunkKey(field, index), null]);
    if (count !== previousCount) writes.push([this.listKey(field), String(count)]);
    return writes;
  }

  private recordKey(field: RecordField, id: string): string {
    return `${this.key}:rec:${field}:${id}`;
  }

  /** Fields added after a workspace was created get their defaults. */
  private upgrade(saved: Partial<OpsState>): OpsState {
    // Workspaces saved before payment settings existed carried only the provider name.
    const legacy = saved.settings as Partial<Settings> & { gateway?: string };
    const payments = withPaymentDefaults(legacy?.payments, legacy?.gateway);
    // Faces captured before tickets and names were kept on them.
    const faces = (saved.faces ?? []).map((face) => (face.ticketId === undefined || face.name === undefined ? { ...face, ticketId: face.ticketId ?? null, name: face.name ?? '' } : face));
    // Releases and support sessions belonged to a platform for many businesses; Dusun Bambu has none.
    const { releases: _releases, support: _support, ...kept } = saved as Partial<OpsState> & { releases?: unknown; support?: unknown };
    return { ...starter('', `owner-${this.accountId}`), ...kept, faces, settings: { ...DEFAULT_SETTINGS, ...saved.settings, payments }, branding: { ...DEFAULT_BRANDING, ...saved.branding } };
  }

  private readList(field: RecordField): Stored[] {
    return this.readIds(field).map((id) => parse<Stored>(this.kv.getItem(this.recordKey(field, id)))).filter((record): record is Stored => record !== null);
  }

  private load(): OpsState | null {
    const saved = parse<Partial<OpsState> & { format?: number }>(this.kv.getItem(this.key));
    if (!saved) return null;
    if (saved.format === 2) {
      this.split = true;
      const { format: _, ...small } = saved;
      const records = Object.fromEntries(RECORD_FIELDS.map((field) => [field, this.readList(field)]));
      return this.upgrade({ ...small, ...records } as Partial<OpsState>);
    }
    // One JSON document, as every build before this one saved it: split it once.
    const state = this.upgrade(saved);
    try {
      this.write(this.everything(state));
      this.split = true;
    } catch {
      // A full disk keeps the old document, which still loads next time.
    }
    return state;
  }

  /** Another window wrote and this store missed the message: start over from the disk. */
  private reload(): void {
    this.rev = this.kv.getItem(this.revKey);
    this.state = this.load() ?? this.state;
    this.emit();
  }

  /** Records another window just saved, applied without reading the rest from the disk. */
  private patch(writes: readonly KeyWrite[]): void {
    const prefix = `${this.key}:`;
    const mine = writes.filter(([key]) => key === this.key || key.startsWith(prefix));
    if (mine.length === 0) return;
    const next: Partial<OpsState> = {};
    const records = new Map<RecordField, Map<string, Stored | null>>();
    const lists = new Set<RecordField>();
    for (const [key, value] of mine) {
      if (key === this.key) {
        const small = parse<Partial<OpsState> & { format?: number }>(value);
        if (small) {
          const { format: _, ...fields } = small;
          Object.assign(next, fields);
        }
      } else if (key === this.revKey) this.rev = value;
      else if (key.startsWith(`${prefix}list:`)) {
        const [field] = key.slice(`${prefix}list:`.length).split(':');
        if (isRecordField(field)) lists.add(field);
      } else if (key.startsWith(`${prefix}rec:`)) {
        const [field, ...id] = key.slice(`${prefix}rec:`.length).split(':');
        if (!isRecordField(field)) continue;
        if (!records.has(field)) records.set(field, new Map());
        records.get(field)!.set(id.join(':'), parse<Stored>(value));
      }
    }
    for (const field of new Set([...records.keys(), ...lists])) {
      const known = new Map((this.state[field] as Stored[]).map((record) => [record.id, record]));
      const changed = records.get(field) ?? new Map<string, Stored | null>();
      // The disk already holds this batch, so a changed list reads back whole.
      const ids = lists.has(field) ? this.readIds(field) : [...known.keys()];
      (next as Record<RecordField, Stored[]>)[field] = ids
        .map((id) => (changed.has(id) ? changed.get(id) : known.get(id) ?? parse<Stored>(this.kv.getItem(this.recordKey(field, id)))))
        .filter((record): record is Stored => !!record);
    }
    this.state = { ...this.state, ...next };
    this.emit();
  }

  private smallDocument(state: OpsState): string {
    const small: Record<string, unknown> = { format: 2 };
    for (const [key, value] of Object.entries(state)) if (!isRecordField(key)) small[key] = value;
    return JSON.stringify(small);
  }

  /** Every key of a state, for a workspace saved for the first time or split from one document. */
  private everything(state: OpsState): KeyWrite[] {
    const writes: KeyWrite[] = [];
    for (const field of RECORD_FIELDS) {
      const list = state[field] as Stored[];
      for (const record of list) writes.push([this.recordKey(field, record.id), JSON.stringify(record)]);
      writes.push(...this.listWrites(field, null, list));
    }
    writes.push([this.key, this.smallDocument(state)]);
    return writes;
  }

  /** What changed between two states, as keys to write. Records first, lists next, removals last. */
  private changes(before: OpsState, after: OpsState): KeyWrite[] {
    const records: KeyWrite[] = [];
    const lists: KeyWrite[] = [];
    const removed: KeyWrite[] = [];
    for (const field of RECORD_FIELDS) {
      const old = before[field] as Stored[];
      const now = after[field] as Stored[];
      if (old === now) continue;
      // Identity tells what changed: the draft copied exactly the records it wrote to. New records
      // go in at the front, so walking both lists from the old end pairs up everything else.
      let i = old.length - 1;
      let j = now.length - 1;
      for (; i >= 0 && j >= 0 && old[i].id === now[j].id; i -= 1, j -= 1) {
        if (old[i] !== now[j]) records.push([this.recordKey(field, now[j].id), JSON.stringify(now[j])]);
      }
      if (i < 0 && j < 0) continue;
      // What did not pair up: new, moved or removed records.
      const previous = new Set(old.slice(0, i + 1));
      for (let k = 0; k <= j; k += 1) if (!previous.has(now[k])) records.push([this.recordKey(field, now[k].id), JSON.stringify(now[k])]);
      if (i >= 0) {
        const ids = new Set(now.map((record) => record.id));
        for (let k = 0; k <= i; k += 1) if (!ids.has(old[k].id)) removed.push([this.recordKey(field, old[k].id), null]);
      }
      lists.push(...this.listWrites(field, old, now, old.length - 1 - i));
    }
    const small = (Object.keys(after) as (keyof OpsState)[]).some((key) => !isRecordField(key) && after[key] !== before[key]);
    return [...records, ...lists, ...(small ? [[this.key, this.smallDocument(after)] as KeyWrite] : []), ...removed];
  }

  private write(writes: readonly KeyWrite[]): void {
    if (this.kv.batch) return this.kv.batch(writes);
    for (const [key, value] of writes) {
      if (value === null) this.kv.removeItem(key);
      else this.kv.setItem(key, value);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  id(): string {
    return uuid();
  }

  /**
   * Applies a change to a draft of the state, then saves what it touched, logs it and tells every
   * window. A change that throws, or that the device cannot save, leaves the state untouched.
   */
  update(change: (draft: OpsState) => void, entry?: Omit<ActivityEntry, 'id' | 'at'>): void {
    // Another window (the customer screen, a second till) may have written without this store hearing.
    if (this.kv.getItem(this.revKey) !== this.rev) this.reload();
    const before = this.state;
    const after = produce(before, (draft) => {
      change(draft);
      if (entry) {
        draft.activity.unshift({ id: this.id(), at: this.now(), ...entry });
        draft.activity.length = Math.min(draft.activity.length, ACTIVITY_LIMIT);
      }
    });
    const rev = this.id();
    try {
      this.write([...(this.split ? this.changes(before, after) : this.everything(after)), [this.revKey, rev]]);
    } catch {
      throw new Error('Penyimpanan perangkat ini penuh, jadi perubahan tidak tersimpan. Kosongkan ruang atau hubungi bantuan sebelum lanjut berjualan.');
    }
    this.rev = rev;
    this.split = true;
    this.state = after;
    this.channel?.postMessage('changed');
    this.emit();
  }
}
