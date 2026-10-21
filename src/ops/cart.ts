// Pricing an order: line totals, the discount preset, the session voucher, and how much of each
// line a refund may give back.

import type { DiscountPreset, Order, OrderLine, Payment, PaymentMethod, Rupiah, Voucher } from './model';
import { voucherDiscount } from './vouchers';

export function formatRupiah(amount: Rupiah): string {
  return `${amount < 0 ? '−' : ''}Rp${Math.abs(Math.round(amount)).toLocaleString('id-ID')}`;
}

export const lineGross = (line: Pick<OrderLine, 'unitPrice' | 'qty'>): Rupiah => line.unitPrice * line.qty;

/** What the customer paid for the line after discounts: the most a refund returns. */
export const lineNet = (line: OrderLine): Rupiah => lineGross(line) - line.discount;

/**
 * Spreads a discount across lines in proportion to their value, giving leftover rupiah to the
 * largest remainders so the parts add up to the whole.
 */
export function spread(amount: Rupiah, weights: readonly Rupiah[]): Rupiah[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (amount * weight) / total);
  const parts = exact.map(Math.floor);
  let left = amount - parts.reduce((sum, part) => sum + part, 0);
  const order = exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest);
  for (const { index } of order) {
    if (left <= 0) break;
    parts[index] += 1;
    left -= 1;
  }
  return parts;
}

export interface Priced {
  lines: OrderLine[];
  subtotal: Rupiah;
  discount: Rupiah;
  total: Rupiah;
}

/** The preset discounts the whole order; a voucher then discounts the session lines that remain. */
export function priceLines(lines: readonly OrderLine[], preset: DiscountPreset | null, voucher: Voucher | null): Priced {
  const gross = lines.map(lineGross);
  const subtotal = gross.reduce((sum, value) => sum + value, 0);
  const presetOff = !preset
    ? 0
    : preset.kind === 'percent'
      ? Math.round((subtotal * Math.min(100, preset.value)) / 100)
      : Math.min(subtotal, preset.value);
  const presetParts = spread(presetOff, gross);
  const afterPreset = gross.map((value, index) => value - presetParts[index]);

  const sessionWeights = lines.map((line, index) => (line.kind === 'session' ? afterPreset[index] : 0));
  const sessionTotal = sessionWeights.reduce((sum, value) => sum + value, 0);
  const voucherOff = voucher ? voucherDiscount(voucher, sessionTotal) : 0;
  const voucherParts = spread(voucherOff, sessionWeights);

  const priced = lines.map((line, index) => ({ ...line, discount: presetParts[index] + voucherParts[index] }));
  const discount = presetOff + voucherOff;
  return { lines: priced, subtotal, discount, total: subtotal - discount };
}

export const paidAmount = (payments: readonly Payment[]): Rupiah =>
  payments.filter((payment) => payment.status === 'paid').reduce((sum, payment) => sum + payment.amount, 0);

export const amountDue = (order: Pick<Order, 'total' | 'payments'>): Rupiah => Math.max(0, order.total - paidAmount(order.payments));

/** Cash back to the customer. Never negative: short cash is refused before this. */
export const changeFor = (tendered: Rupiah, due: Rupiah): Rupiah => Math.max(0, tendered - due);

/** The method a refund goes back through: cash if the order took any cash, else the first paid method. */
export function refundMethod(order: Order): PaymentMethod {
  const paid = order.payments.filter((payment) => payment.status === 'paid');
  return paid.some((payment) => payment.method === 'cash') ? 'cash' : (paid[0]?.method ?? 'cash');
}

/** "INV-261019-0007": the day in the booth's zone, then a running number for the workspace. */
export function orderNumber(prefix: string, date: string, counter: number): string {
  return `${prefix}-${date.slice(2).replaceAll('-', '')}-${String(counter).padStart(4, '0')}`;
}
