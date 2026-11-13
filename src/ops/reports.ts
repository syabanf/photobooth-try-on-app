// Reports: revenue grouped by day, booth, branch, shift, product, frame or mode; the floor (queue,
// gate and AI prints); CSV export; and the settlement check of a gateway report against the ledger.

import { lineNet, paidAmount } from './cart';
import type { BoothSession, FaceRecord, LineKind, Order, Payment, Refund, Rupiah, Ticket } from './model';
import { zonedTime } from './time';

export type GroupBy = 'day' | 'branch' | 'booth' | 'shift' | 'product' | 'frame' | 'mode';

export const PRODUCT_LABELS: Record<LineKind, string> = { session: 'Photo sessions', preset: 'AI presets', print: 'Extra prints', reprint: 'Reprints', merch: 'Merchandise' };

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

  if (groupBy === 'product') {
    // One row per kind of thing sold, from its lines: an order with a session and two prints
    // counts in both rows, and a refund lands on the row of the line it gave back.
    const paid = input.orders.filter((order) => order.status === 'paid');
    for (const order of paid) {
      for (const kind of new Set(order.lines.map((line) => line.kind))) row(kind).orders += 1;
      for (const line of order.lines) {
        const entry = row(line.kind);
        entry.gross += lineNet(line);
        if (line.kind === 'session') entry.sessions += line.qty;
      }
    }
    const lines = new Map(paid.flatMap((order) => order.lines.map((line) => [line.id, line] as const)));
    for (const refund of input.refunds) {
      const line = lines.get(refund.lineId);
      if (line) row(line.kind).refunds += refund.amount;
    }
    for (const entry of rows.values()) entry.net = entry.gross - entry.refunds;
    return [...rows.values()].sort((a, b) => b.net - a.net);
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

export interface FloorReport {
  tickets: number;
  served: number;
  skipped: number;
  /** Average minutes from taking a ticket to being called, for tickets that were called. */
  averageWait: number | null;
  /** Tickets the gate camera photographed at least one face for. */
  partiesPhotographed: number;
  faces: number;
  /** AI preset prints sold, at the booth panel or the kiosk. */
  presetPrints: number;
  presetRevenue: Rupiah;
  /** Tickets per hour of the day, 0 to 23, in the report's time zone. */
  byHour: number[];
}

/** How the floor ran: the queue, the gate camera and what the parties bought as AI prints. */
export function floorReport(input: { tickets: readonly Ticket[]; faces: readonly FaceRecord[]; orders: readonly Order[]; timeZone: string }): FloorReport {
  const called = input.tickets.filter((ticket) => ticket.calledAt);
  const waits = called.map((ticket) => (ticket.calledAt! - ticket.createdAt) / 60_000);
  const photographed = new Set(input.faces.map((face) => face.ticketId).filter((id): id is string => id !== null));
  const presetLines = input.orders.filter((order) => order.status === 'paid').flatMap((order) => order.lines.filter((line) => line.kind === 'preset'));
  const byHour = Array.from({ length: 24 }, () => 0);
  for (const ticket of input.tickets) byHour[Math.floor(zonedTime(ticket.createdAt, input.timeZone).minutes / 60) % 24] += 1;
  return {
    tickets: input.tickets.length,
    served: input.tickets.filter((ticket) => ticket.status === 'done').length,
    skipped: input.tickets.filter((ticket) => ticket.status === 'skipped').length,
    averageWait: waits.length ? waits.reduce((sum, minutes) => sum + minutes, 0) / waits.length : null,
    partiesPhotographed: input.tickets.filter((ticket) => photographed.has(ticket.id)).length,
    faces: input.faces.length,
    presetPrints: presetLines.reduce((sum, line) => sum + line.qty, 0),
    presetRevenue: presetLines.reduce((sum, line) => sum + lineNet(line), 0),
    byHour,
  };
}
