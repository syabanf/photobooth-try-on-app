// Reports: revenue grouped by day, booth, branch, shift, frame or mode; CSV export; and the
// settlement check of a gateway report against the ledger.

import { lineNet, paidAmount } from './cart';
import type { BoothSession, Order, Payment, Refund, Rupiah } from './model';
import { zonedTime } from './time';

export type GroupBy = 'day' | 'branch' | 'booth' | 'shift' | 'frame' | 'mode';

export interface ReportRow {
  key: string;
  label: string;
  orders: number;
  sessions: number;
  gross: Rupiah;
  refunds: Rupiah;
  net: Rupiah;
}

export interface ReportInput {
  orders: readonly Order[];
  refunds: readonly Refund[];
  sessions: readonly BoothSession[];
  timeZone: string;
  /** Turns a key (booth id, frame id …) into a readable name. */
  label(groupBy: GroupBy, key: string): string;
}

/**
 * One row per group. Orders count once, in the group their sale belongs to; for frame and mode
 * reports the unit is the session, and its price is the revenue.
 */
export function revenueReport(input: ReportInput, groupBy: GroupBy): ReportRow[] {
  const rows = new Map<string, ReportRow>();
  const row = (key: string): ReportRow => {
    let entry = rows.get(key);
    if (!entry) {
      entry = { key, label: input.label(groupBy, key), orders: 0, sessions: 0, gross: 0, refunds: 0, net: 0 };
      rows.set(key, entry);
    }
    return entry;
  };

  if (groupBy === 'frame' || groupBy === 'mode') {
    for (const session of input.sessions) {
      const entry = row(groupBy === 'frame' ? (session.frameId ?? 'none') : session.mode);
      entry.sessions += 1;
      entry.gross += session.price;
      entry.net += session.price;
    }
    return [...rows.values()].sort((a, b) => b.sessions - a.sessions);
  }

  const keyOf = (order: Order): string => {
    if (groupBy === 'day') return zonedTime(order.paidAt ?? order.createdAt, input.timeZone).date;
    if (groupBy === 'branch') return order.branchId;
    if (groupBy === 'booth') return order.boothId ?? 'cashier';
    return order.shiftId ?? 'no-shift';
  };
  const paid = input.orders.filter((order) => order.status === 'paid');
  const byId = new Map(paid.map((order) => [order.id, order]));
  for (const order of paid) {
    const entry = row(keyOf(order));
    entry.orders += 1;
    entry.sessions += order.lines.filter((line) => line.kind === 'session').reduce((sum, line) => sum + line.qty, 0);
    entry.gross += paidAmount(order.payments);
  }
  for (const refund of input.refunds) {
    const order = byId.get(refund.orderId);
    if (order) row(keyOf(order)).refunds += refund.amount;
  }
  for (const entry of rows.values()) entry.net = entry.gross - entry.refunds;
  return [...rows.values()].sort((a, b) => (groupBy === 'day' ? b.key.localeCompare(a.key) : b.net - a.net));
}

export function toCsv(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const cell = (value: string | number) => {
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers, ...rows].map((line) => line.map(cell).join(',')).join('\r\n');
}

/** Best-selling items across paid orders, by quantity, refunds taken out. */
export function bestSellers(orders: readonly Order[]): { label: string; qty: number; revenue: Rupiah }[] {
  const totals = new Map<string, { label: string; qty: number; revenue: Rupiah }>();
  for (const order of orders.filter((o) => o.status === 'paid')) {
    for (const line of order.lines.filter((l) => !l.refunded)) {
      const entry = totals.get(line.label) ?? { label: line.label, qty: 0, revenue: 0 };
      entry.qty += line.qty;
      entry.revenue += lineNet(line);
      totals.set(line.label, entry);
    }
  }
  return [...totals.values()].sort((a, b) => b.qty - a.qty);
}

// ---------- settlement ----------

export interface GatewayRow {
  reference: string;
  amount: Rupiah;
  status: string;
  fee: Rupiah;
}

/** Reads a gateway export with columns reference/order_id, amount/gross_amount, status, fee. */
export function parseGatewayCsv(text: string): GatewayRow[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const split = (line: string) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((cell) => cell.replace(/,$/, '').replace(/^"|"$/g, '').replaceAll('""', '"').trim()).slice(0, -1);
  const headers = split(lines[0]).map((header) => header.toLowerCase());
  const column = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const ref = column('reference', 'order_id', 'external_id', 'invoice');
  const amount = column('amount', 'gross_amount', 'paid_amount');
  const status = column('status', 'transaction_status');
  const fee = column('fee', 'mdr', 'fee_amount');
  if (ref < 0 || amount < 0) throw new Error('The file needs a reference and an amount column.');
  return lines.slice(1).map((line) => {
    const cells = split(line);
    return {
      reference: cells[ref] ?? '',
      amount: Math.round(Number((cells[amount] ?? '0').replace(/[^\d.-]/g, ''))),
      status: status >= 0 ? (cells[status] ?? '').toLowerCase() : 'settlement',
      fee: fee >= 0 ? Math.round(Number((cells[fee] ?? '0').replace(/[^\d.-]/g, ''))) : 0,
    };
  });
}

export interface Settlement {
  matched: { reference: string; amount: Rupiah }[];
  mismatched: { reference: string; ledger: Rupiah; gateway: Rupiah }[];
  missingInLedger: GatewayRow[];
  missingInGateway: Payment[];
  ledgerTotal: Rupiah;
  gatewayTotal: Rupiah;
  fees: Rupiah;
}

const SETTLED = new Set(['settlement', 'settled', 'paid', 'success', 'succeeded', 'capture', 'completed']);

export function reconcileSettlement(payments: readonly Payment[], rows: readonly GatewayRow[]): Settlement {
  const ledger = new Map(payments.filter((p) => p.method === 'qris' && p.status === 'paid').map((p) => [p.reference, p]));
  const settled = rows.filter((row) => SETTLED.has(row.status));
  const seen = new Set<string>();
  const result: Settlement = { matched: [], mismatched: [], missingInLedger: [], missingInGateway: [], ledgerTotal: 0, gatewayTotal: 0, fees: 0 };
  for (const row of settled) {
    result.gatewayTotal += row.amount;
    result.fees += row.fee;
    const payment = ledger.get(row.reference);
    if (!payment) {
      result.missingInLedger.push(row);
      continue;
    }
    seen.add(row.reference);
    if (payment.amount === row.amount) result.matched.push({ reference: row.reference, amount: row.amount });
    else result.mismatched.push({ reference: row.reference, ledger: payment.amount, gateway: row.amount });
  }
  for (const payment of ledger.values()) {
    result.ledgerTotal += payment.amount;
    if (!seen.has(payment.reference)) result.missingInGateway.push(payment);
  }
  return result;
}
