// The account backend. The app talks to the AccountBackend interface only; createLocalBackend is
// the trial build's implementation and keeps everything in this browser. A server implementation
// with the same methods replaces it for production, where the server decides who opens a workspace.

import {
  AccountError,
  TRIAL_LIMITS,
  trialEnd,
  trialExpired,
  type Account,
  type Invite,
  type Location,
  type LocationInput,
  type Member,
  type Point,
  type PointInput,
  type Session,
  type Sites,
} from './model';
import { checkSecret, hashSecret, normalizeEmail, passwordProblem, validEmail } from './password';

export interface Registration {
  business: string;
  name: string;
  email: string;
  password: string;
}

export type OwnerInput = Omit<Registration, 'business'>;

/**
 * Writes that create something take an idempotency key: a retry or a double submit with the same
 * key returns the first result instead of creating a second account, owner or invite.
 */
export interface AccountBackend {
  /** The signed-in person and their workspace, or null. */
  session(): Promise<Session | null>;
  /** The signed-in workspace, or null. */
  current(): Promise<Account | null>;
  /** Every workspace saved on this device, newest first. Customer screens open the right one. */
  workspaces(): Promise<Account[]>;
  /** Workspaces made before sign-in existed, waiting for an owner to secure them. */
  unclaimed(): Promise<Account[]>;
  /** Opens a new workspace with its owner, and signs the owner in. */
  register(input: Registration, key: string): Promise<Session>;
  /** Gives a workspace without sign-in its owner, and signs them in. */
  claim(accountId: string, input: OwnerInput, key: string): Promise<Session>;
  signIn(email: string, password: string): Promise<Session>;
  signOut(): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
  /** Everyone who signs in to the current workspace. */
  members(): Promise<Member[]>;
  /** A code for a person on the Staff page to set a password. A waiting code is reused. */
  invite(input: { userId: string; name: string; email: string }, key: string): Promise<Invite>;
  /** A fresh code, and the old password stops working. */
  resetAccess(userId: string): Promise<Invite>;
  setAccess(userId: string, enabled: boolean): Promise<Member>;
  /** Who a code is for, before they set a password. */
  inviteFor(code: string): Promise<{ account: Account; member: Member }>;
  acceptInvite(code: string, password: string, key: string): Promise<Session>;
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

interface Credential extends Member {
  hash: string;
  salt: string;
  inviteCode: string;
}

const ACCOUNTS_KEY = 'vto:accounts';
const USERS_KEY = 'vto:users';
const SESSION_KEY = 'vto:session';
const ONCE_KEY = 'vto:idempotency';
const sitesKey = (accountId: string) => `vto:sites:${accountId}`;

export const MAX_TRIES = 5;
export const LOCK_MS = 15 * 60_000;
export const INVITE_MS = 7 * 86_400_000;
const ONCE_MS = 86_400_000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function clean(value: string, field: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AccountError(`Enter ${label}.`, field);
  return trimmed;
}

/** "K7QM-2XPA": no 0/O or 1/I/L, so it reads out loud without mistakes. */
function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

function publicMember({ hash: _hash, salt: _salt, inviteCode: _code, ...member }: Credential): Member {
  return member;
}

export function createLocalBackend(store: KeyValueStore, now: () => number = Date.now): AccountBackend {
  const read = <T>(key: string, fallback: T): T => {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  };
  const write = (key: string, value: unknown) => store.setItem(key, JSON.stringify(value));
  const saved = () => read<SavedAccounts>(ACCOUNTS_KEY, {});
  const accounts = () => Object.values(saved()).map((entry) => entry.account);
  const users = () => read<Record<string, Credential>>(USERS_KEY, {});
  const saveUser = (user: Credential) => write(USERS_KEY, { ...users(), [user.userId]: user });
  const byEmail = (email: string) => Object.values(users()).find((user) => user.email === normalizeEmail(email)) ?? null;

  /** Runs a write once per key: a repeat, even while the first is still running, gets its result. */
  const running = new Map<string, Promise<unknown>>();
  function once<T>(scope: string, key: string, run: () => Promise<T>): Promise<T> {
    const id = `${scope}:${key}`;
    const done = read<Record<string, { at: number; value: T }>>(ONCE_KEY, {});
    if (done[id]) return Promise.resolve(done[id].value);
    const pending = running.get(id);
    if (pending) return pending as Promise<T>;
    const work = run()
      .then((value) => {
        const fresh = Object.fromEntries(Object.entries(read<typeof done>(ONCE_KEY, {})).filter(([, entry]) => now() - entry.at < ONCE_MS));
        write(ONCE_KEY, { ...fresh, [id]: { at: now(), value } });
        return value;
      })
      .finally(() => running.delete(id));
    running.set(id, work);
    return work;
  }

  function sessionIds(): { accountId: string; userId: string } | null {
    try {
      const value = JSON.parse(store.getItem(SESSION_KEY) ?? 'null') as { accountId?: string; userId?: string } | null;
      return value?.accountId && value.userId ? { accountId: value.accountId, userId: value.userId } : null;
    } catch {
      // A session from the quick access build held only a workspace id: that workspace needs an owner now.
      return null;
    }
  }

  function currentSession(): Session | null {
    const ids = sessionIds();
    const account = accounts().find((entry) => entry.id === ids?.accountId);
    const user = ids ? users()[ids.userId] : undefined;
    if (!account || !user || user.status !== 'active' || user.accountId !== account.id) return null;
    return { account, member: publicMember(user) };
  }

  function requireSession(): Session {
    const session = currentSession();
    if (!session) throw new AccountError('Sign in again to continue.');
    return session;
  }

  function memberOf(userId: string): Credential {
    const user = users()[userId];
    if (!user || user.accountId !== requireSession().account.id) throw new AccountError('That person has no sign-in here.');
    return user;
  }

  function open(account: Account, user: Credential): Session {
    const signedIn = { ...user, lastSignInAt: now(), failedAttempts: 0, lockedUntil: 0 };
    saveUser(signedIn);
    write(SESSION_KEY, { accountId: account.id, userId: user.userId });
    return { account, member: publicMember(signedIn) };
  }

  async function owner(accountId: string, input: OwnerInput): Promise<Credential> {
    const name = clean(input.name, 'name', 'your name');
    const email = normalizeEmail(input.email);
    if (!validEmail(email)) throw new AccountError('Enter an email like name@example.com.', 'email');
    if (byEmail(email)) throw new AccountError('This email already has an account. Sign in instead.', 'email');
    const problem = passwordProblem(input.password);
    if (problem) throw new AccountError(`Password needs: ${problem.toLowerCase()}.`, 'password');
    const { hash, salt } = await hashSecret(input.password);
    return { userId: `owner-${accountId}`, accountId, name, email, status: 'active', createdAt: now(), lastSignInAt: null, failedAttempts: 0, lockedUntil: 0, inviteExpiresAt: null, hash, salt, inviteCode: '' };
  }

  /** Reuses a waiting code unless `fresh`, so pressing Invite twice hands out one code. */
  function issueCode(user: Credential, fresh = false): Invite {
    const waiting = !fresh && user.status === 'invited' && user.inviteCode && (user.inviteExpiresAt ?? 0) > now();
    const next: Credential = waiting ? user : { ...user, status: 'invited', inviteCode: newCode(), inviteExpiresAt: now() + INVITE_MS, hash: '', salt: '', failedAttempts: 0, lockedUntil: 0 };
    saveUser(next);
    return { code: next.inviteCode, expiresAt: next.inviteExpiresAt!, member: publicMember(next) };
  }

  function invited(code: string): Credential {
    const wanted = normalizeCode(code);
    const user = Object.values(users()).find((entry) => entry.status === 'invited' && entry.inviteCode === wanted);
    if (!user) throw new AccountError('That code is not valid. Check it, or ask for a new one.', 'code');
    if ((user.inviteExpiresAt ?? 0) <= now()) throw new AccountError('That code has expired. Ask the owner for a new one.', 'code');
    return user;
  }

  /** Every write to locations and points: signed in, and still inside the trial. */
  function editableSites(): { account: Account; sites: Sites; commit(): void } {
    const { account } = requireSession();
    if (trialExpired(account, now())) throw new AccountError('Your trial has ended. Changes are locked.');
    const sites = read<Sites>(sitesKey(account.id), { locations: [], points: [] });
    return { account, sites, commit: () => write(sitesKey(account.id), sites) };
  }

  return {
    async session() {
      return currentSession();
    },

    async current() {
      return currentSession()?.account ?? null;
    },

    async workspaces() {
      return accounts().sort((a, b) => b.createdAt - a.createdAt);
    },

    async unclaimed() {
      const owned = new Set(Object.values(users()).map((user) => user.accountId));
      return accounts().filter((account) => !owned.has(account.id)).sort((a, b) => b.createdAt - a.createdAt);
    },

    register(input, key) {
      return once('register', key, async () => {
        const business = clean(input.business, 'business', 'the business name');
        const createdAt = now();
        const account: Account = { id: crypto.randomUUID(), business, createdAt, trialEndsAt: trialEnd(createdAt) };
        const user = await owner(account.id, input);
        write(ACCOUNTS_KEY, { ...saved(), [account.id]: { account } });
        return open(account, user);
      });
    },

    claim(accountId, input, key) {
      return once('claim', key, async () => {
        const account = accounts().find((entry) => entry.id === accountId);
        if (!account) throw new AccountError('That workspace is no longer on this device.');
        if (Object.values(users()).some((user) => user.accountId === accountId)) throw new AccountError('This workspace already has an owner. Sign in with their email.');
        return open(account, await owner(accountId, input));
      });
    },

    async signIn(email, password) {
      const user = byEmail(email);
      const wrong = new AccountError('Email or password is wrong.', 'password');
      if (!user) throw wrong;
      if (user.status === 'disabled') throw new AccountError('Sign-in is turned off for this email. Ask the workspace owner.', 'email');
      if (user.status === 'invited') throw new AccountError('This email has an invite waiting. Use the code you were given to set a password.', 'email');
      if (user.lockedUntil > now()) {
        const minutes = Math.ceil((user.lockedUntil - now()) / 60_000);
        throw new AccountError(`Too many wrong passwords. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, or ask the owner to unlock you.`, 'password');
      }
      if (!(await checkSecret(password, user.hash, user.salt))) {
        const failedAttempts = user.failedAttempts + 1;
        const locked = failedAttempts >= MAX_TRIES;
        saveUser({ ...user, failedAttempts: locked ? 0 : failedAttempts, lockedUntil: locked ? now() + LOCK_MS : 0 });
        if (locked) throw new AccountError(`Too many wrong passwords. Sign-in is locked for ${LOCK_MS / 60_000} minutes.`, 'password');
        const left = MAX_TRIES - failedAttempts;
        throw new AccountError(`Email or password is wrong. ${left} ${left === 1 ? 'try' : 'tries'} left before a short lock.`, 'password');
      }
      const account = accounts().find((entry) => entry.id === user.accountId);
      if (!account) throw new AccountError('That workspace is no longer on this device.');
      return open(account, user);
    },

    async signOut() {
      store.removeItem(SESSION_KEY);
    },

    async changePassword(current, next) {
      const user = users()[requireSession().member.userId];
      if (!(await checkSecret(current, user.hash, user.salt))) throw new AccountError('Your current password is wrong.', 'current');
      const problem = passwordProblem(next);
      if (problem) throw new AccountError(`Password needs: ${problem.toLowerCase()}.`, 'next');
      if (current === next) throw new AccountError('Pick a password you have not used here.', 'next');
      saveUser({ ...user, ...(await hashSecret(next)) });
    },

    async members() {
      const { account } = requireSession();
      return Object.values(users()).filter((user) => user.accountId === account.id).map(publicMember);
    },

    invite(input, key) {
      return once('invite', key, async () => {
        const { account } = requireSession();
        const email = normalizeEmail(input.email);
        if (!validEmail(email)) throw new AccountError('Add an email like name@example.com to this person first.', 'email');
        const taken = byEmail(email);
        if (taken && taken.userId !== input.userId) throw new AccountError(`${email} already signs in as ${taken.name}.`, 'email');
        const existing = users()[input.userId];
        if (existing?.status === 'active') throw new AccountError(`${existing.name} already signs in. Reset their password instead.`);
        const base: Credential = existing ?? { userId: input.userId, accountId: account.id, name: '', email, status: 'invited', createdAt: now(), lastSignInAt: null, failedAttempts: 0, lockedUntil: 0, inviteExpiresAt: null, hash: '', salt: '', inviteCode: '' };
        return issueCode({ ...base, name: input.name.trim(), email });
      });
    },

    async resetAccess(userId) {
      const user = memberOf(userId);
      if (userId === requireSession().member.userId) throw new AccountError('Change your own password from your account instead.');
      return issueCode(user, true);
    },

    async setAccess(userId, enabled) {
      const user = memberOf(userId);
      if (userId === requireSession().member.userId) throw new AccountError('You cannot turn off your own sign-in.');
      if (enabled && user.status === 'disabled' && !user.hash) throw new AccountError(`${user.name} never set a password. Send a new code instead.`);
      const next: Credential = { ...user, status: enabled ? (user.hash ? 'active' : user.status) : 'disabled', failedAttempts: 0, lockedUntil: 0 };
      saveUser(next);
      return publicMember(next);
    },

    async inviteFor(code) {
      const user = invited(code);
      const account = accounts().find((entry) => entry.id === user.accountId);
      if (!account) throw new AccountError('That workspace is no longer on this device.', 'code');
      return { account, member: publicMember(user) };
    },

    acceptInvite(code, password, key) {
      return once('accept', key, async () => {
        const user = invited(code);
        const problem = passwordProblem(password);
        if (problem) throw new AccountError(`Password needs: ${problem.toLowerCase()}.`, 'password');
        const account = accounts().find((entry) => entry.id === user.accountId);
        if (!account) throw new AccountError('That workspace is no longer on this device.', 'code');
        return open(account, { ...user, ...(await hashSecret(password)), status: 'active', inviteCode: '', inviteExpiresAt: null });
      });
    },

    async sites() {
      const account = currentSession()?.account;
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
