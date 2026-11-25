// Reports for running Dusun Bambu day to day: how a period did against the one before it, when the
// venue is busy, what each cashier rang up and gave back, what discounts cost, and the one-page
// close of a day. Pure, so the Reports page and the printed close read the same numbers.

import { paidAmount } from './cart';
import type { ActivityEntry, Channel, DiscountPreset, Order, PaymentMethod, Refund, Rupiah, Voucher } from './model';
import { zonedTime } from './time';

const DAY_MS = 86_400_000;

export interface Totals {
  /** Paid orders. */
  orders: number;
  gross: Rupiah;
  refunds: Rupiah;
  net: Rupiah;
  /** Net per paid order, rounded to the rupiah. */
  average: Rupiah;
  discount: Rupiah;
  sessions: number;
  /** Extra prints and reprints, by the sheet. */
  prints: number;
}

/** Paid orders and the refunds on them. A refund counts in the period its order was sold in. */
export function totals(orders: readonly Order[], refunds: readonly Refund[]): Totals {
  const paid = orders.filter((order) => order.status === 'paid');
  const ids = new Set(paid.map((order) => order.id));
  const gross = paid.reduce((sum, order) => sum + paidAmount(order.payments), 0);
  const refunded = refunds.filter((refund) => ids.has(refund.orderId)).reduce((sum, refund) => sum + refund.amount, 0);
  const qty = (kinds: string[]) => paid.reduce((sum, order) => sum + order.lines.filter((line) => kinds.includes(line.kind)).reduce((lines, line) => lines + line.qty, 0), 0);
  return {
    orders: paid.length,
    gross,
    refunds: refunded,
    net: gross - refunded,
    average: paid.length ? Math.round((gross - refunded) / paid.length) : 0,
    discount: paid.reduce((sum, order) => sum + order.discount, 0),
    sessions: qty(['session']),
    prints: qty(['print', 'reprint']),
  };
}

/** Whole percent change, or null when the period before had nothing to compare with. */
export function change(now: number, before: number): number | null {
  return before ? Math.round(((now - before) / before) * 100) : null;
}

const toDay = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const fromDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The days ("YYYY-MM-DD") from one date to another, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = toDay(from); day <= toDay(to); day += DAY_MS) days.push(fromDay(day));
  return days;
}

/** The period just as long that ends the day before `from`: seven days are compared with the seven before. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const length = toDay(to) - toDay(from) + DAY_MS;
  return { from: fromDay(toDay(from) - length), to: fromDay(toDay(from) - DAY_MS) };
}

export type Compare = 'previous' | 'year' | 'none';

/** The same dates a year earlier; 29 February falls back to the 28th. */
function yearEarlier(date: string): string {
  const year = Number(date.slice(0, 4)) - 1;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return date.endsWith('-02-29') && !leap ? `${year}-02-28` : `${year}${date.slice(4)}`;
}

/** The period a report is compared with, or null when it is compared with nothing. */
export function compareRange(from: string, to: string, compare: Compare): { from: string; to: string } | null {
  if (compare === 'none') return null;
  return compare === 'previous' ? previousRange(from, to) : { from: yearEarlier(from), to: yearEarlier(to) };
}

/** What a report looks at. An empty value means everything. */
export interface ReportFilter {
  branchId: string;
  /** A booth id, or 'cashier' for sales rung up at the till. */
  boothId: string;
  channel: Channel | '';
  staffId: string;
}

export const NO_FILTER: ReportFilter = { branchId: '', boothId: '', channel: '', staffId: '' };

export function matchesFilter(order: Order, filter: ReportFilter): boolean {
  return (
    (!filter.branchId || order.branchId === filter.branchId) &&
    (!filter.boothId || (order.boothId ?? 'cashier') === filter.boothId) &&
    (!filter.channel || order.channel === filter.channel) &&
    (!filter.staffId || order.staffId === filter.staffId)
  );
}

export type Metric = 'net' | 'orders' | 'sessions';

/** One value per day for a chart: net revenue, paid orders or sessions sold, by the day of the sale. */
export function dailySeries(orders: readonly Order[], refunds: readonly Refund[], days: readonly string[], timeZone: string, metric: Metric): number[] {
  const index = new Map(days.map((day, at) => [day, at]));
  const values = days.map(() => 0);
  const dayOf = new Map<string, number>();
  for (const order of orders) {
    if (order.status !== 'paid') continue;
    const at = index.get(zonedTime(order.paidAt ?? order.createdAt, timeZone).date);
    if (at === undefined) continue;
    dayOf.set(order.id, at);
    if (metric === 'orders') values[at] += 1;
    else if (metric === 'sessions') values[at] += order.lines.filter((line) => line.kind === 'session').reduce((sum, line) => sum + line.qty, 0);
    else values[at] += paidAmount(order.payments);
  }
  if (metric === 'net') {
    for (const refund of refunds) {
      const at = dayOf.get(refund.orderId);
      if (at !== undefined) values[at] -= refund.amount;
    }
  }
  return values;
}

export interface BusyHours {
  /** [weekday 0 = Sunday][hour 0–23]. */
  orders: number[][];
  revenue: Rupiah[][];
  /** The busiest hour of the week, by paid orders. */
  peak: { weekday: number; hour: number; orders: number } | null;
}

/** Paid orders by weekday and hour, in the venue's time zone: when to roster crew and hold a happy hour. */
export function busyHours(orders: readonly Order[], timeZone: string): BusyHours {
  const grid = () => Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const result: BusyHours = { orders: grid(), revenue: grid(), peak: null };
  for (const order of orders) {
    if (order.status !== 'paid') continue;
    const { weekday, minutes } = zonedTime(order.paidAt ?? order.createdAt, timeZone);
    const hour = Math.floor(minutes / 60);
    result.orders[weekday][hour] += 1;
    result.revenue[weekday][hour] += paidAmount(order.payments);
    const count = result.orders[weekday][hour];
    if (!result.peak || count > result.peak.orders) result.peak = { weekday, hour, orders: count };
  }
  return result;
}

export interface StaffRow {
  /** Null for sales nobody rang up: the kiosk and the booths selling on their own. */
  staffId: string | null;
  orders: number;
  gross: Rupiah;
  refunds: number;
  refunded: Rupiah;
  /** Refunds this person approved with their PIN, for anyone. */
  approved: number;
  voids: number;
}

/**
 * What each person sold, gave back and cancelled. Refunds count for the cashier who asked for them,
 * approvals for the supervisor whose PIN cleared them, and cancellations for whoever voided the order.
 */
export function staffReport(orders: readonly Order[], refunds: readonly Refund[], voids: readonly ActivityEntry[]): StaffRow[] {
  const rows = new Map<string | null, StaffRow>();
  const row = (staffId: string | null) => {
    let entry = rows.get(staffId);
    if (!entry) rows.set(staffId, (entry = { staffId, orders: 0, gross: 0, refunds: 0, refunded: 0, approved: 0, voids: 0 }));
    return entry;
  };
  for (const order of orders) {
    if (order.status !== 'paid') continue;
    const entry = row(order.staffId);
    entry.orders += 1;
    entry.gross += paidAmount(order.payments);
  }
  for (const refund of refunds) {
    const entry = row(refund.staffId);
    entry.refunds += 1;
    entry.refunded += refund.amount;
    row(refund.supervisorId).approved += 1;
  }
  for (const entry of voids) row(entry.staffId).voids += 1;
  return [...rows.values()].sort((a, b) => b.gross - a.gross);
}

export interface DiscountRow {
  key: string;
  kind: 'voucher' | 'preset' | 'receipt';
  /** The voucher code, the preset's name, or null for receipt codes, which all share one row. */
  name: string | null;
  orders: number;
  discount: Rupiah;
  /** What those orders brought in after the discount. */
  revenue: Rupiah;
}

/**
 * Paid orders that used a voucher or a discount preset, one row per voucher code or preset. An order
 * with both counts under its voucher. Codes printed on cashier receipts share one row: they unlock a
 * session already paid for, so their discount is the session price, not money given away.
 */
export function discountReport(orders: readonly Order[], vouchers: readonly Voucher[], presets: readonly DiscountPreset[]): DiscountRow[] {
  const receiptCodes = new Set(vouchers.filter((voucher) => voucher.orderId).map((voucher) => voucher.code));
  const rows = new Map<string, DiscountRow>();
  for (const order of orders) {
    if (order.status !== 'paid' || (!order.voucherCode && !order.presetId)) continue;
    const receipt = !!order.voucherCode && receiptCodes.has(order.voucherCode);
    const key = receipt ? 'receipt' : order.voucherCode ? `voucher:${order.voucherCode}` : `preset:${order.presetId}`;
    let entry = rows.get(key);
    if (!entry) {
      const name = receipt ? null : order.voucherCode ?? presets.find((preset) => preset.id === order.presetId)?.name ?? 'Preset terhapus';
      rows.set(key, (entry = { key, kind: receipt ? 'receipt' : order.voucherCode ? 'voucher' : 'preset', name, orders: 0, discount: 0, revenue: 0 }));
    }
    entry.orders += 1;
    entry.discount += order.discount;
    entry.revenue += paidAmount(order.payments);
  }
  return [...rows.values()].sort((a, b) => b.discount - a.discount);
}

/** Money taken per payment method on paid orders. */
export function takenByMethod(orders: readonly Order[]): Record<PaymentMethod, Rupiah> {
  const taken: Record<PaymentMethod, Rupiah> = { cash: 0, qris: 0, card: 0, ewallet: 0 };
  for (const order of orders) {
    if (order.status !== 'paid') continue;
    for (const payment of order.payments) if (payment.status === 'paid') taken[payment.method] += payment.amount;
  }
  return taken;
}
