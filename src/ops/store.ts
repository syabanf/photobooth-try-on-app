// The business store: one JSON document per workspace, with an activity log and a broadcast so
// the customer screen and the queue TV in other windows redraw on every change. The document
// lives in IndexedDB (big-store.ts), or in localStorage where the browser has no IndexedDB.
// Pictures (frames, logo, ads) live in IndexedDB through blobs.ts, since they outgrow localStorage.

import type { KeyValueStore } from '../account/backend';
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
    releases: [],
    support: [],
    activity: [],
    settings: { ...DEFAULT_SETTINGS },
    counters: { order: 0, ticket: 0 },
  };
}

/** The log keeps the newest entries; the cloud has the rest once synced. */
export const ACTIVITY_LIMIT = 2000;

export type Listener = (state: OpsState) => void;

export class OpsStore {
  state: OpsState;
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  /** The saved text `state` was parsed from, so an unchanged document is not parsed again. */
  private raw: string | null = null;
  readonly key: string;

  constructor(
    readonly kv: KeyValueStore,
    readonly accountId: string,
    business: string,
    readonly now: () => number = Date.now,
  ) {
    this.key = `vto:ops:${accountId}`;
    this.state = this.read() ?? starter(business, `owner-${accountId}`);
    const refresh = () => {
      this.state = this.read() ?? this.state;
      this.emit();
    };
    if (kv.watch) {
      kv.watch(this.key, refresh);
      return;
    }
    try {
      this.channel = new BroadcastChannel(this.key);
      this.channel.onmessage = refresh;
    } catch {
      // No BroadcastChannel (old browser, tests): other windows only refresh on reload.
    }
  }

  private read(): OpsState | null {
    try {
      const raw = this.kv.getItem(this.key);
      if (!raw) return null;
      if (raw === this.raw) return this.state;
      const saved = JSON.parse(raw) as OpsState;
      // Fields added after a workspace was created get their defaults.
      // Workspaces saved before payment settings existed carried only the provider name.
      const legacy = saved.settings as Partial<Settings> & { gateway?: string };
      const payments = withPaymentDefaults(legacy?.payments, legacy?.gateway);
      // Faces captured before tickets and names were kept on them.
      const faces = (saved.faces ?? []).map((face) => ({ ...face, ticketId: face.ticketId ?? null, name: face.name ?? '' }));
      const state = { ...starter('', `owner-${this.accountId}`), ...saved, faces, settings: { ...DEFAULT_SETTINGS, ...saved.settings, payments }, branding: { ...DEFAULT_BRANDING, ...saved.branding } };
      this.raw = raw;
      return state;
    } catch {
      return null;
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
   * Applies a change to a copy of the state, then saves, logs and tells every window. A change
   * that throws, or that the device cannot save, leaves the state untouched.
   */
  update(change: (draft: OpsState) => void, entry?: Omit<ActivityEntry, 'id' | 'at'>): void {
    // Re-read first: another window (the customer screen, a second till) may have written since.
    this.state = this.read() ?? this.state;
    // Parsing the saved text makes the copy: it takes a third of the time structuredClone needs on
    // a large document, and the state is plain JSON either way.
    const draft: OpsState = this.raw ? JSON.parse(this.raw) : structuredClone(this.state);
    change(draft);
    if (entry) {
      draft.activity.unshift({ id: this.id(), at: this.now(), ...entry });
      draft.activity.length = Math.min(draft.activity.length, ACTIVITY_LIMIT);
    }
    const raw = JSON.stringify(draft);
    try {
      this.kv.setItem(this.key, raw);
    } catch {
      throw new Error('Penyimpanan perangkat ini penuh, jadi perubahan tidak tersimpan. Kosongkan ruang atau hubungi bantuan sebelum lanjut berjualan.');
    }
    this.state = draft;
    this.raw = raw;
    this.channel?.postMessage('changed');
    this.emit();
  }
}
