// Role-based access: what each role may do, which branches a person sees, and supervisor PINs.

import { checkSecret, hashSecret } from '../account/password';
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

export const PERMISSIONS: readonly Permission[] = EVERYTHING;

export const PERMISSION_LABELS: Record<Permission, string> = {
  'pos.sell': 'Sell at the till',
  'pos.refund': 'Refund at the till',
  'pos.discount': 'Give discounts',
  'shift.run': 'Open and close shifts',
  'queue.run': 'Run the queue, the gate and faces',
  'booth.run': 'Run booth sessions',
  'history.view': 'See transactions and payments',
  'reports.view': 'See reports and activity history',
  'vouchers.manage': 'Manage vouchers',
  'frames.manage': 'Manage frames and AI presets',
  'branding.manage': 'Manage branding and ads',
  'devices.manage': 'Manage devices and alerts',
  'staff.manage': 'Manage people, roles and sign-in',
  'settings.manage': 'Change prices, locations and settings',
  'fleet.manage': 'Updates and remote support',
};

/** Permissions in the groups the Roles page shows them in. */
export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  { label: 'Selling', permissions: ['pos.sell', 'pos.discount', 'pos.refund', 'shift.run', 'history.view'] },
  { label: 'On the floor', permissions: ['queue.run', 'booth.run'] },
  { label: 'Content', permissions: ['vouchers.manage', 'frames.manage', 'branding.manage'] },
  { label: 'Running the business', permissions: ['reports.view', 'devices.manage', 'settings.manage', 'staff.manage', 'fleet.manage'] },
];

/** Roles whose permissions the owner changed on the Roles page. The owner role never changes. */
let overrides: Partial<Record<Role, Permission[]>> = {};

export function setRoleOverrides(next: Partial<Record<Role, Permission[]>> | undefined): void {
  overrides = next ?? {};
}

export function permissionsOf(role: Role): readonly Permission[] {
  return role === 'owner' ? EVERYTHING : (overrides[role] ?? ROLES[role].can);
}

/** Whether a role's permissions differ from the ones it ships with. */
export const roleChanged = (role: Role) => role !== 'owner' && !!overrides[role];

export const can = (staff: Pick<Staff, 'role'> | null, permission: Permission): boolean =>
  !!staff && permissionsOf(staff.role).includes(permission);

/** Refunds need a supervisor's PIN, even when a supervisor runs the till. */
export const approves = (staff: Pick<Staff, 'role' | 'active'>): boolean =>
  staff.active && (staff.role === 'owner' || staff.role === 'admin' || staff.role === 'supervisor');

/** Staff data scoping: a person with branches listed sees only those. */
export function seesBranch(staff: Pick<Staff, 'branchIds'> | null, branchId: string | null): boolean {
  if (!staff || staff.branchIds.length === 0) return true;
  return branchId !== null && staff.branchIds.includes(branchId);
}

// ---------- PINs ----------

function validPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

export async function hashPin(pin: string): Promise<{ pinHash: string; pinSalt: string }> {
  if (!validPin(pin)) throw new Error('A PIN is 4 to 8 digits.');
  const { hash, salt } = await hashSecret(pin);
  return { pinHash: hash, pinSalt: salt };
}

export async function checkPin(staff: Pick<Staff, 'pinHash' | 'pinSalt'>, pin: string): Promise<boolean> {
  return validPin(pin) && checkSecret(pin, staff.pinHash, staff.pinSalt);
}

/** The first approver whose PIN matches, so the supervisor on the floor just types theirs. */
export async function findApprover(staff: readonly Staff[], pin: string): Promise<Staff | null> {
  for (const person of staff) {
    if (approves(person) && (await checkPin(person, pin))) return person;
  }
  return null;
}
