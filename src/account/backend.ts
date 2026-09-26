// The account backend. The app talks to the AccountBackend interface only; createLocalBackend is
// the trial build's implementation and keeps everything in this browser. A server implementation
// with the same methods replaces it for production, where the server decides who opens a workspace.

import {
  AccountError,
  TRIAL_LIMITS,
  trialEnd,
  trialExpired,
  type Account,
  type Location,
  type LocationInput,
  type Point,
  type PointInput,
  type Sites,
} from './model';

export interface AccountBackend {
  /** The signed-in account, or null. */
  current(): Promise<Account | null>;
  /** Every workspace saved on this device, newest first. */
  workspaces(): Promise<Account[]>;
  /** Opens a new trial workspace and signs in to it. A blank name gets a numbered one. */
  startTrial(business: string): Promise<Account>;
  signIn(accountId: string): Promise<Account>;
  signOut(): Promise<void>;
  sites(): Promise<Sites>;
  saveLocation(input: LocationInput): Promise<Location>;
  /** Removes the location and every point in it. */
  deleteLocation(id: string): Promise<void>;
  savePoint(input: PointInput): Promise<Point>;
  deletePoint(id: string): Promise<void>;
}

/** The part of the Web Storage API the backend uses, so tests can pass a Map-backed fake. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** localStorage, or memory when the browser refuses it (some private windows do). */
export function browserStore(): KeyValueStore {
  try {
    localStorage.setItem('vto:probe', '1');
    localStorage.removeItem('vto:probe');
    return localStorage;
  } catch {
    return memoryStore();
  }
}

/** Entries keep the `{ account }` shape of the earlier password build, so its workspaces still open. */
type SavedAccounts = Record<string, { account: Account }>;

const ACCOUNTS_KEY = 'vto:accounts';
const SESSION_KEY = 'vto:session';
const sitesKey = (accountId: string) => `vto:sites:${accountId}`;

function clean(value: string, field: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AccountError(`Enter a ${label}.`, field);
  return trimmed;
}

export function createLocalBackend(store: KeyValueStore, now: () => number = Date.now): AccountBackend {
  const read = <T>(key: string, fallback: T): T => {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  };
  const write = (key: string, value: unknown) => store.setItem(key, JSON.stringify(value));
  const saved = () => read<SavedAccounts>(ACCOUNTS_KEY, {});
  const accounts = () => Object.values(saved()).map((entry) => entry.account);

  function sessionAccount(): Account | null {
    const id = store.getItem(SESSION_KEY);
    return accounts().find((account) => account.id === id) ?? null;
  }

  /** Every write goes through here: signed in, and still inside the trial. */
  function editableSites(): { account: Account; sites: Sites; commit(): void } {
    const account = sessionAccount();
    if (!account) throw new AccountError('Sign in again to continue.');
    if (trialExpired(account, now())) throw new AccountError('Your trial has ended. Changes are locked.');
    const sites = read<Sites>(sitesKey(account.id), { locations: [], points: [] });
    return { account, sites, commit: () => write(sitesKey(account.id), sites) };
  }

  return {
    async current() {
      return sessionAccount();
    },

    async workspaces() {
      return accounts().sort((a, b) => b.createdAt - a.createdAt);
    },

    async startTrial(business) {
      const all = saved();
      const createdAt = now();
      const account: Account = {
        id: crypto.randomUUID(),
        business: business.trim() || `Store ${Object.keys(all).length + 1}`,
        createdAt,
        trialEndsAt: trialEnd(createdAt),
      };
      all[account.id] = { account };
      write(ACCOUNTS_KEY, all);
      store.setItem(SESSION_KEY, account.id);
      return account;
    },

    async signIn(accountId) {
      const account = accounts().find((entry) => entry.id === accountId);
      if (!account) throw new AccountError('That workspace is no longer on this device.');
      store.setItem(SESSION_KEY, account.id);
      return account;
    },

    async signOut() {
      store.removeItem(SESSION_KEY);
    },

    async sites() {
      const account = sessionAccount();
      return account ? read<Sites>(sitesKey(account.id), { locations: [], points: [] }) : { locations: [], points: [] };
    },

    async saveLocation(input) {
      const { sites, commit } = editableSites();
      const fields = {
        name: clean(input.name, 'name', 'location name'),
        city: clean(input.city, 'city', 'city'),
        address: input.address.trim(),
      };
      const existing = sites.locations.find((location) => location.id === input.id);
      if (existing) {
        Object.assign(existing, fields);
        commit();
        return existing;
      }
      if (sites.locations.length >= TRIAL_LIMITS.locations) {
        throw new AccountError(`The trial covers up to ${TRIAL_LIMITS.locations} locations.`);
      }
      const location: Location = { id: crypto.randomUUID(), createdAt: now(), ...fields };
      sites.locations.push(location);
      commit();
      return location;
    },

    async deleteLocation(id) {
      const { sites, commit } = editableSites();
      sites.locations = sites.locations.filter((location) => location.id !== id);
      sites.points = sites.points.filter((point) => point.locationId !== id);
      commit();
    },

    async savePoint(input) {
      const { sites, commit } = editableSites();
      if (!sites.locations.some((location) => location.id === input.locationId)) {
        throw new AccountError('Pick a location.', 'locationId');
      }
      const fields = {
        locationId: input.locationId,
        name: clean(input.name, 'name', 'point name'),
        code: clean(input.code, 'code', 'code').toUpperCase(),
        active: input.active,
      };
      if (sites.points.some((point) => point.code === fields.code && point.id !== input.id)) {
        throw new AccountError(`${fields.code} is already in use.`, 'code');
      }
      const existing = sites.points.find((point) => point.id === input.id);
      if (existing) {
        Object.assign(existing, fields);
        commit();
        return existing;
      }
      if (sites.points.length >= TRIAL_LIMITS.points) {
        throw new AccountError(`The trial covers up to ${TRIAL_LIMITS.points} points.`);
      }
      const point: Point = { id: crypto.randomUUID(), createdAt: now(), ...fields };
      sites.points.push(point);
      commit();
      return point;
    },

    async deletePoint(id) {
      const { sites, commit } = editableSites();
      sites.points = sites.points.filter((point) => point.id !== id);
      commit();
    },
  };
}
