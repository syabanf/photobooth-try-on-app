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
  owner: { label: 'Pemilik', detail: 'Semua izin, semua cabang', can: EVERYTHING },
  admin: { label: 'Admin', detail: 'Mengelola semuanya kecuali pengaturan pemilik', can: EVERYTHING.filter((p) => p !== 'staff.manage') },
  supervisor: {
    label: 'Supervisor',
    detail: 'Menyetujui refund dan diskon, mengelola shift dan perangkat',
    can: ['pos.sell', 'pos.refund', 'pos.discount', 'shift.run', 'queue.run', 'booth.run', 'history.view', 'reports.view', 'vouchers.manage', 'devices.manage'],
  },
  cashier: { label: 'Kasir', detail: 'Berjualan, menjalankan shift dan antrean', can: ['pos.sell', 'shift.run', 'queue.run', 'history.view'] },
  operator: { label: 'Operator booth', detail: 'Menjalankan booth dan antrean', can: ['booth.run', 'queue.run'] },
};

export const PERMISSIONS: readonly Permission[] = EVERYTHING;

export const PERMISSION_LABELS: Record<Permission, string> = {
  'pos.sell': 'Berjualan di kasir',
  'pos.refund': 'Refund di kasir',
  'pos.discount': 'Memberi diskon',
  'shift.run': 'Buka dan tutup shift',
  'queue.run': 'Menjalankan antrean, gerbang dan wajah',
  'booth.run': 'Menjalankan sesi booth',
  'history.view': 'Melihat transaksi dan pembayaran',
  'reports.view': 'Melihat laporan dan riwayat aktivitas',
  'vouchers.manage': 'Mengelola voucher',
  'frames.manage': 'Mengelola bingkai dan preset AI',
  'branding.manage': 'Mengelola merek dan iklan',
  'devices.manage': 'Mengelola perangkat dan peringatan',
  'staff.manage': 'Mengelola tim, peran dan akses masuk',
  'settings.manage': 'Mengubah harga, lokasi dan pengaturan',
  'fleet.manage': 'Pembaruan dan bantuan jarak jauh',
};

/** Permissions in the groups the Roles page shows them in. */
export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  { label: 'Penjualan', permissions: ['pos.sell', 'pos.discount', 'pos.refund', 'shift.run', 'history.view'] },
  { label: 'Operasional', permissions: ['queue.run', 'booth.run'] },
  { label: 'Konten', permissions: ['vouchers.manage', 'frames.manage', 'branding.manage'] },
  { label: 'Pengelolaan bisnis', permissions: ['reports.view', 'devices.manage', 'settings.manage', 'staff.manage', 'fleet.manage'] },
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
  if (!validPin(pin)) throw new Error('PIN terdiri dari 4 sampai 8 angka.');
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
