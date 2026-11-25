// The business, its people, locations and points: the types every backend returns.

/** The one business this app runs. */
export const BUSINESS = 'Dusun Bambu';

/** Dusun Bambu's records on this device: its people, locations and points. */
export interface Account {
  id: string;
  business: string;
  createdAt: number;
}

export type MemberStatus = 'active' | 'invited' | 'disabled';

/** Someone who signs in to a workspace. The id matches their record on the Staff page. */
export interface Member {
  userId: string;
  accountId: string;
  name: string;
  email: string;
  status: MemberStatus;
  createdAt: number;
  lastSignInAt: number | null;
  failedAttempts: number;
  /** Wrong passwords lock the sign-in until this time. 0 when open. */
  lockedUntil: number;
  /** When the waiting invite or reset code stops working. */
  inviteExpiresAt: number | null;
}

export interface Session {
  account: Account;
  member: Member;
}

/** A one-time code that lets an invited person, or one whose password was reset, set a password. */
export interface Invite {
  code: string;
  expiresAt: number;
  member: Member;
}

export type AuthEventKind = 'register' | 'claim' | 'signin' | 'failed' | 'locked' | 'signout' | 'invite' | 'accepted' | 'reset' | 'password' | 'disabled' | 'enabled' | 'unlocked' | 'screen';

export const AUTH_EVENT_LABELS: Record<AuthEventKind, string> = {
  register: 'Mengatur pemilik',
  claim: 'Mengamankan usaha',
  signin: 'Masuk',
  failed: 'Kata sandi salah',
  locked: 'Dikunci karena kata sandi salah',
  signout: 'Keluar',
  invite: 'Kode masuk dikirim',
  accepted: 'Membuat kata sandi dari kode',
  reset: 'Kata sandi direset',
  password: 'Mengganti kata sandi',
  disabled: 'Akses masuk dimatikan',
  enabled: 'Akses masuk dinyalakan',
  unlocked: 'Kunci dibuka',
  screen: 'Membuka layar yang terkunci',
};

/** One line of the sign-in log: who, what happened to their sign-in, from which device, and who did it. */
export interface AuthEvent {
  id: string;
  accountId: string;
  userId: string;
  name: string;
  kind: AuthEventKind;
  at: number;
  device: string;
  /** The person who acted on someone else's sign-in, such as the owner who reset it. */
  byName: string | null;
}

/** A store, mall or venue. */
export interface Location {
  id: string;
  name: string;
  city: string;
  address: string;
  createdAt: number;
}

/** One kiosk, mirror or booth running the app, standing in a location. */
export interface Point {
  id: string;
  locationId: string;
  name: string;
  code: string;
  active: boolean;
  createdAt: number;
}

export interface Sites {
  locations: Location[];
  points: Point[];
}

export type LocationInput = Pick<Location, 'name' | 'city' | 'address'> & { id?: string };
export type PointInput = Pick<Point, 'locationId' | 'name' | 'code' | 'active'> & { id?: string };

/** A rejected request. `field` names the form input to mark, when one is to blame. */
export class AccountError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

/** "Grand Indonesia" with GRA-01 taken gives GRA-02. */
export function suggestPointCode(locationName: string, taken: readonly string[]): string {
  const prefix = locationName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'PT';
  const used = new Set(taken.map((code) => code.toUpperCase()));
  for (let n = 1; ; n++) {
    const code = `${prefix}-${String(n).padStart(2, '0')}`;
    if (!used.has(code)) return code;
  }
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words.at(-1)![0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}
