// The shift slip: what came in, by method, and whether the cash drawer matches.

import { paidAmount } from './cart';
import type { Order, PaymentMethod, Refund, Rupiah, Shift } from './model';

export interface ShiftSlip {
  orders: number;
  gross: Rupiah;
  refunds: Rupiah;
  net: Rupiah;
  byMethod: Record<PaymentMethod, Rupiah>;
  refundsByMethod: Record<PaymentMethod, Rupiah>;
  openingCash: Rupiah;
  expectedCash: Rupiah;
  countedCash: Rupiah | null;
  /** Counted minus expected: negative means the drawer is short. */
  variance: Rupiah | null;
}

const zero = (): Record<PaymentMethod, Rupiah> => ({ cash: 0, qris: 0, card: 0, ewallet: 0 });

export function shiftSlip(shift: Shift, orders: readonly Order[], refunds: readonly Refund[]): ShiftSlip {
  const inShift = orders.filter((order) => order.shiftId === shift.id && order.status === 'paid');
  const ids = new Set(inShift.map((order) => order.id));
  const end = shift.closedAt ?? Infinity;
  const shiftRefunds = refunds.filter((refund) => ids.has(refund.orderId) || (refund.at >= shift.openedAt && refund.at <= end && refund.staffId === shift.staffId));

  const byMethod = zero();
  for (const order of inShift) {
    for (const payment of order.payments) if (payment.status === 'paid') byMethod[payment.method] += payment.amount;
  }
  const refundsByMethod = zero();
  for (const refund of shiftRefunds) refundsByMethod[refund.method] += refund.amount;

  const gross = inShift.reduce((sum, order) => sum + paidAmount(order.payments), 0);
  const refundTotal = shiftRefunds.reduce((sum, refund) => sum + refund.amount, 0);
  const expectedCash = shift.openingCash + byMethod.cash - refundsByMethod.cash;
  const counted = shift.countedCash ?? null;
  return {
    orders: inShift.length,
    gross,
    refunds: refundTotal,
    net: gross - refundTotal,
    byMethod,
    refundsByMethod,
    openingCash: shift.openingCash,
    expectedCash,
    countedCash: counted,
    variance: counted === null ? null : counted - expectedCash,
  };
}
