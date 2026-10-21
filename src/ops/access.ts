// Role-based access: what each role may do, which branches a person sees, and supervisor PINs.

import type { Role, Staff } from './model';

export type Permission =
  | 'pos.sell'
  | 'pos.refund'
  | 'pos.discount'
  | 'shift.run'
  | 'queue.run'
  | 'booth.run'
  | 'history.view'
  | 'reports.view'
  | 'vouchers.manage'
  | 'frames.manage'
  | 'branding.manage'
  | 'devices.manage'
  | 'staff.manage'
  | 'settings.manage'
  | 'fleet.manage';

const EVERYTHING: Permission[] = [
  'pos.sell',
  'pos.refund',
  'pos.discount',
  'shift.run',
  'queue.run',
  'booth.run',
  'history.view',
  'reports.view',
  'vouchers.manage',
  'frames.manage',
  'branding.manage',
  'devices.manage',
  'staff.manage',
  'settings.manage',
  'fleet.manage',
];

export const ROLES: Record<Role, { label: string; detail: string; can: Permission[] }> = {
  owner: { label: 'Owner', detail: 'Everything, every branch', can: EVERYTHING },
  admin: { label: 'Admin', detail: 'Runs the workspace except owner settings', can: EVERYTHING.filter((p) => p !== 'staff.manage') },
  supervisor: {
    label: 'Supervisor',
    detail: 'Approves refunds and discounts, runs shifts and devices',
    can: ['pos.sell', 'pos.refund', 'pos.discount', 'shift.run', 'queue.run', 'booth.run', 'history.view', 'reports.view', 'vouchers.manage', 'devices.manage'],
  },
  cashier: { label: 'Cashier', detail: 'Sells, runs a shift and the queue', can: ['pos.sell', 'shift.run', 'queue.run', 'history.view'] },
  operator: { label: 'Booth operator', detail: 'Runs booths and the queue', can: ['booth.run', 'queue.run'] },
};

export const can = (staff: Pick<Staff, 'role'> | null, permission: Permission): boolean =>
  !!staff && ROLES[staff.role].can.includes(permission);

/** Refunds need a supervisor's PIN, even when a supervisor runs the till. */
export const approves = (staff: Pick<Staff, 'role' | 'active'>): boolean =>
  staff.active && (staff.role === 'owner' || staff.role === 'admin' || staff.role === 'supervisor');

/** Staff data scoping: a person with branches listed sees only those. */
export function seesBranch(staff: Pick<Staff, 'branchIds'> | null, branchId: string | null): boolean {
  if (!staff || staff.branchIds.length === 0) return true;
  return branchId !== null && staff.branchIds.includes(branchId);
}

// ---------- PINs ----------

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

async function derive(pin: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 120_000 }, key, 256);
  return toHex(new Uint8Array(bits));
}

function validPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

export async function hashPin(pin: string): Promise<{ pinHash: string; pinSalt: string }> {
  if (!validPin(pin)) throw new Error('A PIN is 4 to 8 digits.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { pinHash: await derive(pin, salt), pinSalt: toHex(salt) };
}

export async function checkPin(staff: Pick<Staff, 'pinHash' | 'pinSalt'>, pin: string): Promise<boolean> {
  if (!staff.pinHash || !validPin(pin)) return false;
  return (await derive(pin, fromHex(staff.pinSalt))) === staff.pinHash;
}

/** The first approver whose PIN matches, so the supervisor on the floor just types theirs. */
export async function findApprover(staff: readonly Staff[], pin: string): Promise<Staff | null> {
  for (const person of staff) {
    if (approves(person) && (await checkPin(person, pin))) return person;
  }
  return null;
}
