// The business store: one JSON document per workspace in localStorage, with an activity log and
// a broadcast so the customer screen and the queue TV in other windows redraw on every change.
// Pictures (frames, logo, ads) live in IndexedDB through blobs.ts, since they outgrow localStorage.

import type { KeyValueStore } from '../account/backend';
import type { ActivityEntry, Branding, OpsState, Preset, Settings } from './model';
import { DEFAULT_PAYMENTS, withPaymentDefaults } from './payments';

const DEFAULT_BRANDING: Branding = {
  brandName: '',
  logo: '',
  accent: '#f04e30',
  ink: '#101112',
  background: '#f1f0f1',
  welcome: 'Tap to start',
  thanks: 'Scan to get your photos',
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
  receiptFooter: 'Thank you! Show this receipt at the booth.',
  queuePrefix: 'A',
  faceLibrary: 'all',
};

const preset = (id: string, name: string, layout: Preset['layout'], prompt: string): Preset => ({ id, name, layout, prompt, frameId: null, active: true, builtIn: true });

/** The templates every workspace starts with. Owners edit their prompts and add their own. */
export const BUILT_IN_PRESETS: Preset[] = [
  preset('cover', 'Magazine cover', 'cover', 'Restyle as a glossy fashion magazine cover shot: studio lighting, crisp skin detail, bold editorial colour grade, sharp focus on the face.'),
  preset('polaroid', 'Polaroid', 'polaroid', 'Make this a real instant-film photo: soft flash, warm faded colours, light grain and gentle vignette, like a candid party snapshot.'),
  preset('poster', 'Movie poster', 'poster', 'Turn this into a cinematic movie poster: dramatic rim light, teal and orange grade, haze in the background, the person as the lead star.'),
  preset('pass', 'VIP pass', 'pass', 'Make this a premium event VIP pass photo: clean studio portrait, even soft light, neutral backdrop, printed on glossy card stock.'),
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
const ACTIVITY_LIMIT = 2000;

export type Listener = (state: OpsState) => void;

export class OpsStore {
  state: OpsState;
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  readonly key: string;

  constructor(
    private readonly store: KeyValueStore,
    readonly accountId: string,
    business: string,
    readonly now: () => number = Date.now,
  ) {
    this.key = `vto:ops:${accountId}`;
    this.state = this.read() ?? starter(business, `owner-${accountId}`);
    try {
      this.channel = new BroadcastChannel(this.key);
      this.channel.onmessage = () => {
        this.state = this.read() ?? this.state;
        this.emit();
      };
    } catch {
      // No BroadcastChannel (old browser, tests): other windows only refresh on reload.
    }
  }

  private read(): OpsState | null {
    try {
      const raw = this.store.getItem(this.key);
      if (!raw) return null;
      const saved = JSON.parse(raw) as OpsState;
      // Fields added after a workspace was created get their defaults.
      // Workspaces saved before payment settings existed carried only the provider name.
      const legacy = saved.settings as Partial<Settings> & { gateway?: string };
      const payments = withPaymentDefaults(legacy?.payments, legacy?.gateway);
      return { ...starter('', `owner-${this.accountId}`), ...saved, settings: { ...DEFAULT_SETTINGS, ...saved.settings, payments }, branding: { ...DEFAULT_BRANDING, ...saved.branding } };
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
    return crypto.randomUUID();
  }

  /**
   * Applies a change to a copy of the state, then saves, logs and tells every window. A change
   * that throws leaves the state untouched.
   */
  update(change: (draft: OpsState) => void, entry?: Omit<ActivityEntry, 'id' | 'at'>): void {
    // Re-read first: another window (the customer screen, a second till) may have written since.
    const draft = structuredClone(this.read() ?? this.state);
    change(draft);
    if (entry) {
      draft.activity.unshift({ id: this.id(), at: this.now(), ...entry });
      draft.activity.length = Math.min(draft.activity.length, ACTIVITY_LIMIT);
    }
    this.state = draft;
    this.store.setItem(this.key, JSON.stringify(draft));
    this.channel?.postMessage('changed');
    this.emit();
  }
}
