// The voucher engine: who may use a code, where, and when, judged on the booth's local clock.

import type { Frame, Rupiah, Voucher } from './model';
import { WEEKDAY_NAMES, clockMinutes, zonedTime } from './time';

export interface VoucherContext {
  now: number;
  /** null at the cashier, where any booth's code may be sold or checked. */
  boothId: string | null;
  timeZone: string;
}

export type VoucherCheck = { ok: true; voucher: Voucher } | { ok: false; reason: string };

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

function describeHours(voucher: Voucher): string {
  const hours = voucher.happyHour!;
  const days = hours.days.length === 7 ? 'every day' : hours.days.map((day) => WEEKDAY_NAMES[day]).join(', ');
  return `${days} ${hours.start}–${hours.end}`;
}

/** Why a voucher cannot be used right now, or null when it can. */
export function voucherProblem(voucher: Voucher, context: VoucherContext): string | null {
  if (!voucher.active) return 'This voucher is switched off.';
  if (context.boothId && voucher.boothIds.length && !voucher.boothIds.includes(context.boothId)) {
    return 'This voucher is not valid at this booth.';
  }
  const local = zonedTime(context.now, context.timeZone);
  if (voucher.validFrom && local.date < voucher.validFrom) return `Valid from ${voucher.validFrom}.`;
  if (voucher.validTo && local.date > voucher.validTo) return `Expired on ${voucher.validTo}.`;
  if (voucher.happyHour) {
    const { days, start, end } = voucher.happyHour;
    const inHours = local.minutes >= clockMinutes(start) && local.minutes < clockMinutes(end);
    if (!days.includes(local.weekday) || !inHours) return `Valid ${describeHours(voucher)} only.`;
  }
  if (voucher.uses >= voucher.maxUses) return voucher.scope === 'single' ? 'This voucher was already used.' : 'This voucher has no uses left.';
  return null;
}

export function checkVoucher(vouchers: readonly Voucher[], code: string, context: VoucherContext): VoucherCheck {
  const wanted = normalizeCode(code);
  if (!wanted) return { ok: false, reason: 'Enter a voucher code.' };
  const voucher = vouchers.find((candidate) => candidate.code === wanted);
  if (!voucher) return { ok: false, reason: `No voucher matches ${wanted}.` };
  const problem = voucherProblem(voucher, context);
  return problem ? { ok: false, reason: problem } : { ok: true, voucher };
}

/** The free-event voucher running at a booth now, if any: every session there is free. */
export function activeEvent(vouchers: readonly Voucher[], context: VoucherContext): Voucher | null {
  return vouchers.find((voucher) => voucher.eventMode && voucherProblem(voucher, context) === null) ?? null;
}

export function voucherDiscount(voucher: Voucher, amount: Rupiah): Rupiah {
  if (voucher.kind === 'free') return amount;
  if (voucher.kind === 'percent') return Math.min(amount, Math.round((amount * voucher.value) / 100));
  return Math.min(amount, voucher.value);
}

/**
 * Frames a customer may pick. A frame listed on any voucher is locked, and only that voucher
 * unlocks it.
 */
export function availableFrames(frames: readonly Frame[], vouchers: readonly Voucher[], applied: Voucher | null): Frame[] {
  const locked = new Set(vouchers.flatMap((voucher) => voucher.frameIds));
  return frames.filter((frame) => frame.active && (!locked.has(frame.id) || applied?.frameIds.includes(frame.id)));
}

/** Letters and digits that cannot be misread for each other on a receipt. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateCode(prefix: string, length = 6, random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < length; i++) code += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return `${normalizeCode(prefix)}${code}`;
}
