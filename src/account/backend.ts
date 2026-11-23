// The account backend. The app talks to the AccountBackend interface only; createLocalBackend is
// the trial build's implementation and keeps everything in this browser. A server implementation
// with the same methods replaces it for production, where the server decides who opens a workspace.

import {
  AccountError,
  TRIAL_LIMITS,
  trialEnd,
  trialExpired,
  type Account,
  type AuthEvent,
  type AuthEventKind,
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
import { uuid } from '../uuid';

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
  /**
   * Checks a team member's email and password without touching this device's session, for
   * unlocking a locked screen. Wrong passwords count toward the same lock as sign-in.
   */
  confirmMember(accountId: string, email: string, password: string): Promise<Member>;
  /** Sign-ins, failures, locks and access changes in the current workspace, newest first. */
  signInLog(): Promise<AuthEvent[]>;
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
  /** Calls `listener` when another window of this browser changes `key`. Stores that can tell have it. */
  watch?(key: string, listener: () => void): void;
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
const LOG_KEY = 'vto:auth-log';
const LOG_LIMIT = 1000;
const sitesKey = (accountId: string) => `vto:sites:${accountId}`;

export const MAX_TRIES = 5;
export const LOCK_MS = 15 * 60_000;
export const INVITE_MS = 7 * 86_400_000;
const ONCE_MS = 86_400_000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function clean(value: string, field: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AccountError(`Isi ${label}.`, field);
  return trimmed;
}

/** "K7QM-2XPA": no 0/O or 1/I/L, so it reads out loud without mistakes. */
function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

/** "Chrome di macOS": enough to tell the booth tablet from the owner's phone. */
export function deviceLabel(agent: string): string {
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '';
  const system = /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Mac OS X|Macintosh/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  return [browser, system].filter(Boolean).join(' di ') || 'Perangkat tidak dikenal';
}

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

  const device = deviceLabel(globalThis.navigator?.userAgent ?? '');
  /** The credential behind an email and password; wrong passwords count toward the lock. */
  async function checkCredentials(email: string, password: string): Promise<Credential> {
    const user = byEmail(email);
    const wrong = new AccountError('Email atau kata sandi salah.', 'password');
    // Each browser address keeps its own accounts in this build: localhost:5173 and the booth
    // server at 192.168.x.x:4173 do not share them. Say so instead of blaming the password.
    if (Object.keys(users()).length === 0) {
      const here = typeof location === 'undefined' ? 'alamat ini' : location.host;
      throw new AccountError(`Belum ada akun di ${here}. Akun tersimpan di alamat browser tempat akun itu dibuat. Buat akun di sini, atau buka alamat tempat Anda mendaftar.`, 'email');
    }
    if (!user) throw wrong;
    if (user.status === 'disabled') throw new AccountError('Akses masuk untuk email ini dimatikan. Hubungi pemilik usaha.', 'email');
    if (user.status === 'invited') throw new AccountError('Email ini punya undangan yang belum dipakai. Pakai kode yang Anda terima untuk membuat kata sandi.', 'email');
    if (user.lockedUntil > now()) {
      const minutes = Math.ceil((user.lockedUntil - now()) / 60_000);
      throw new AccountError(`Terlalu banyak kata sandi salah. Coba lagi dalam ${minutes} menit, atau minta pemilik membuka kunci akun Anda.`, 'password');
    }
    if (!(await checkSecret(password, user.hash, user.salt))) {
      const failedAttempts = user.failedAttempts + 1;
      const locked = failedAttempts >= MAX_TRIES;
      saveUser({ ...user, failedAttempts: locked ? 0 : failedAttempts, lockedUntil: locked ? now() + LOCK_MS : 0 });
      record(user, locked ? 'locked' : 'failed');
      if (locked) throw new AccountError(`Terlalu banyak kata sandi salah. Akses masuk dikunci selama ${LOCK_MS / 60_000} menit.`, 'password');
      const left = MAX_TRIES - failedAttempts;
      throw new AccountError(`Email atau kata sandi salah. Sisa ${left} kali percobaan sebelum dikunci sebentar.`, 'password');
    }
    return user;
  }

  function record(user: Pick<Credential, 'accountId' | 'userId' | 'name'>, kind: AuthEventKind, by: Session | null = null): void {
    const event: AuthEvent = { id: uuid(), accountId: user.accountId, userId: user.userId, name: user.name, kind, at: now(), device, byName: by && by.member.userId !== user.userId ? by.member.name : null };
    write(LOG_KEY, [event, ...read<AuthEvent[]>(LOG_KEY, [])].slice(0, LOG_LIMIT));
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
    if (!session) throw new AccountError('Masuk lagi untuk melanjutkan.');
    return session;
  }

  function memberOf(userId: string): Credential {
    const user = users()[userId];
    if (!user || user.accountId !== requireSession().account.id) throw new AccountError('Orang itu tidak punya akses masuk di sini.');
    return user;
  }

  function open(account: Account, user: Credential): Session {
    const signedIn = { ...user, lastSignInAt: now(), failedAttempts: 0, lockedUntil: 0 };
    saveUser(signedIn);
    write(SESSION_KEY, { accountId: account.id, userId: user.userId });
    return { account, member: publicMember(signedIn) };
  }

  async function owner(accountId: string, input: OwnerInput): Promise<Credential> {
    const name = clean(input.name, 'name', 'nama Anda');
    const email = normalizeEmail(input.email);
    if (!validEmail(email)) throw new AccountError('Isi email seperti nama@contoh.com.', 'email');
    if (byEmail(email)) throw new AccountError('Email ini sudah punya akun. Silakan masuk.', 'email');
    const problem = passwordProblem(input.password);
    if (problem) throw new AccountError(`Kata sandi perlu ${problem.toLowerCase()}.`, 'password');
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
    if (!user) throw new AccountError('Kode itu tidak valid. Periksa lagi, atau minta kode baru.', 'code');
    if ((user.inviteExpiresAt ?? 0) <= now()) throw new AccountError('Kode itu sudah kedaluwarsa. Minta kode baru ke pemilik.', 'code');
    return user;
  }

  /** Every write to locations and points: signed in, and still inside the trial. */
  function editableSites(): { account: Account; sites: Sites; commit(): void } {
    const { account } = requireSession();
    if (trialExpired(account, now())) throw new AccountError('Masa coba sudah berakhir. Perubahan dikunci.');
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
        const business = clean(input.business, 'business', 'nama usaha');
        const createdAt = now();
        const account: Account = { id: uuid(), business, createdAt, trialEndsAt: trialEnd(createdAt) };
        const user = await owner(account.id, input);
        write(ACCOUNTS_KEY, { ...saved(), [account.id]: { account } });
        record(user, 'register');
        return open(account, user);
      });
    },

    claim(accountId, input, key) {
      return once('claim', key, async () => {
        const account = accounts().find((entry) => entry.id === accountId);
        if (!account) throw new AccountError('Usaha itu sudah tidak ada di perangkat ini.');
        if (Object.values(users()).some((user) => user.accountId === accountId)) throw new AccountError('Usaha ini sudah punya pemilik. Masuk dengan email pemilik.');
        const user = await owner(accountId, input);
        record(user, 'claim');
        return open(account, user);
      });
    },

    async signIn(email, password) {
      const user = await checkCredentials(email, password);
      const account = accounts().find((entry) => entry.id === user.accountId);
      if (!account) throw new AccountError('Usaha itu sudah tidak ada di perangkat ini.');
      record(user, 'signin');
      return open(account, user);
    },

    async signOut() {
      const session = currentSession();
      if (session) record(session.member, 'signout');
      store.removeItem(SESSION_KEY);
    },

    async changePassword(current, next) {
      const user = users()[requireSession().member.userId];
      if (!(await checkSecret(current, user.hash, user.salt))) throw new AccountError('Kata sandi sekarang salah.', 'current');
      const problem = passwordProblem(next);
      if (problem) throw new AccountError(`Kata sandi perlu ${problem.toLowerCase()}.`, 'next');
      if (current === next) throw new AccountError('Pilih kata sandi yang belum pernah dipakai di sini.', 'next');
      saveUser({ ...user, ...(await hashSecret(next)) });
      record(user, 'password');
    },

    async members() {
      const { account } = requireSession();
      return Object.values(users()).filter((user) => user.accountId === account.id).map(publicMember);
    },

    invite(input, key) {
      return once('invite', key, async () => {
        const { account } = requireSession();
        const email = normalizeEmail(input.email);
        if (!validEmail(email)) throw new AccountError('Tambahkan dulu email orang ini, seperti nama@contoh.com.', 'email');
        const taken = byEmail(email);
        if (taken && taken.userId !== input.userId) throw new AccountError(`${email} sudah dipakai oleh ${taken.name}.`, 'email');
        const existing = users()[input.userId];
        if (existing?.status === 'active') throw new AccountError(`${existing.name} sudah bisa masuk. Reset kata sandinya saja.`);
        const base: Credential = existing ?? { userId: input.userId, accountId: account.id, name: '', email, status: 'invited', createdAt: now(), lastSignInAt: null, failedAttempts: 0, lockedUntil: 0, inviteExpiresAt: null, hash: '', salt: '', inviteCode: '' };
        const invite = issueCode({ ...base, name: input.name.trim(), email });
        // A code handed out again is the same code: one log line.
        if (invite.code !== existing?.inviteCode) record(invite.member, 'invite', currentSession());
        return invite;
      });
    },

    async resetAccess(userId) {
      const user = memberOf(userId);
      if (userId === requireSession().member.userId) throw new AccountError('Ganti kata sandi Anda sendiri lewat menu akun.');
      record(user, 'reset', currentSession());
      return issueCode(user, true);
    },

    async setAccess(userId, enabled) {
      const user = memberOf(userId);
      if (userId === requireSession().member.userId) throw new AccountError('Anda tidak bisa mematikan akses masuk Anda sendiri.');
      if (enabled && user.status === 'disabled' && !user.hash) throw new AccountError(`${user.name} belum pernah membuat kata sandi. Kirim kode baru saja.`);
      const next: Credential = { ...user, status: enabled ? (user.hash ? 'active' : user.status) : 'disabled', failedAttempts: 0, lockedUntil: 0 };
      saveUser(next);
      const kind = !enabled ? 'disabled' : user.status === 'disabled' ? 'enabled' : 'unlocked';
      if (kind !== 'unlocked' || user.lockedUntil > now()) record(user, kind, currentSession());
      return publicMember(next);
    },

    async inviteFor(code) {
      const user = invited(code);
      const account = accounts().find((entry) => entry.id === user.accountId);
      if (!account) throw new AccountError('Usaha itu sudah tidak ada di perangkat ini.', 'code');
      return { account, member: publicMember(user) };
    },

    acceptInvite(code, password, key) {
      return once('accept', key, async () => {
        const user = invited(code);
        const problem = passwordProblem(password);
        if (problem) throw new AccountError(`Kata sandi perlu ${problem.toLowerCase()}.`, 'password');
        const account = accounts().find((entry) => entry.id === user.accountId);
        if (!account) throw new AccountError('Usaha itu sudah tidak ada di perangkat ini.', 'code');
        record(user, 'accepted');
        return open(account, { ...user, ...(await hashSecret(password)), status: 'active', inviteCode: '', inviteExpiresAt: null });
      });
    },

    async confirmMember(accountId, email, password) {
      const user = await checkCredentials(email, password);
      if (user.accountId !== accountId) throw new AccountError('Email itu tidak ada di tim usaha ini.', 'email');
      record(user, 'screen');
      return publicMember(user);
    },

    async signInLog() {
      const { account } = requireSession();
      return read<AuthEvent[]>(LOG_KEY, []).filter((event) => event.accountId === account.id);
    },

    async sites() {
      const account = currentSession()?.account;
      return account ? read<Sites>(sitesKey(account.id), { locations: [], points: [] }) : { locations: [], points: [] };
    },

    async saveLocation(input) {
      const { sites, commit } = editableSites();
      const fields = {
        name: clean(input.name, 'name', 'nama lokasi'),
        city: clean(input.city, 'city', 'kota'),
        address: input.address.trim(),
      };
      const existing = sites.locations.find((location) => location.id === input.id);
      if (existing) {
        Object.assign(existing, fields);
        commit();
        return existing;
      }
      if (sites.locations.length >= TRIAL_LIMITS.locations) {
        throw new AccountError(`Masa coba hanya untuk maksimal ${TRIAL_LIMITS.locations} lokasi.`);
      }
      const location: Location = { id: uuid(), createdAt: now(), ...fields };
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
        throw new AccountError('Pilih lokasi.', 'locationId');
      }
      const fields = {
        locationId: input.locationId,
        name: clean(input.name, 'name', 'nama booth'),
        code: clean(input.code, 'code', 'kode').toUpperCase(),
        active: input.active,
      };
      if (sites.points.some((point) => point.code === fields.code && point.id !== input.id)) {
        throw new AccountError(`${fields.code} sudah dipakai.`, 'code');
      }
      const existing = sites.points.find((point) => point.id === input.id);
      if (existing) {
        Object.assign(existing, fields);
        commit();
        return existing;
      }
      if (sites.points.length >= TRIAL_LIMITS.points) {
        throw new AccountError(`Masa coba hanya untuk maksimal ${TRIAL_LIMITS.points} booth.`);
      }
      const point: Point = { id: uuid(), createdAt: now(), ...fields };
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
