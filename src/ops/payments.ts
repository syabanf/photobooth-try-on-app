// Payment rules: which methods a channel may take, the fee each one costs, when a QR runs out,
// and the flat list of payments the Payments page shows.

import { PAYMENT_METHODS, type Channel, type Order, type Payment, type PaymentMethod, type PaymentSettings, type PaymentStatus, type Refund, type Rupiah } from './model';

export const GATEWAY_NAMES = { midtrans: 'Midtrans', xendit: 'Xendit', doku: 'DOKU' } as const;

export const DEFAULT_PAYMENTS: PaymentSettings = {
  gateway: { provider: 'midtrans', mode: 'sandbox', merchantId: '', clientKey: '', qrExpiryMinutes: 15 },
  methods: {
    cash: { enabled: true, cashier: true, booth: false, feePercent: 0 },
    qris: { enabled: true, cashier: true, booth: true, feePercent: 0.7 },
    card: { enabled: true, cashier: true, booth: false, feePercent: 1.5 },
    ewallet: { enabled: true, cashier: true, booth: false, feePercent: 1.5 },
  },
  wallets: ['GoPay', 'OVO', 'DANA', 'ShopeePay'],
  terminals: [],
};

/** A saved record from before these settings existed, or a partly edited one, filled in. */
export function withPaymentDefaults(saved: Partial<PaymentSettings> | undefined, legacyProvider?: string): PaymentSettings {
  const methods = { ...DEFAULT_PAYMENTS.methods };
  for (const method of Object.keys(methods) as PaymentMethod[]) methods[method] = { ...methods[method], ...saved?.methods?.[method] };
  const provider = saved?.gateway?.provider ?? (legacyProvider as PaymentSettings['gateway']['provider'] | undefined) ?? DEFAULT_PAYMENTS.gateway.provider;
  return {
    gateway: { ...DEFAULT_PAYMENTS.gateway, ...saved?.gateway, provider },
    methods,
    wallets: saved?.wallets ?? [...DEFAULT_PAYMENTS.wallets],
    terminals: saved?.terminals ?? [],
  };
}

export function gatewayLabel(settings: PaymentSettings): string {
  const { provider, mode } = settings.gateway;
  return mode === 'production' ? GATEWAY_NAMES[provider] : `${GATEWAY_NAMES[provider]} sandbox`;
}

export function methodAllowed(settings: PaymentSettings, method: PaymentMethod, channel: Channel): boolean {
  const rule = settings.methods[method];
  return rule.enabled && (channel === 'cashier' ? rule.cashier : rule.booth);
}

export function allowedMethods(settings: PaymentSettings, channel: Channel): PaymentMethod[] {
  return PAYMENT_METHODS.filter((method) => methodAllowed(settings, method, channel));
}

/** The processing fee on an amount, in whole rupiah. */
export function feeFor(settings: PaymentSettings, method: PaymentMethod, amount: Rupiah): Rupiah {
  return Math.round((amount * settings.methods[method].feePercent) / 100);
}

export function isExpired(payment: Payment, now: number): boolean {
  return payment.status === 'pending' && payment.expiresAt !== undefined && now >= payment.expiresAt;
}

/** A payment with the order it belongs to, for lists and exports. */
export interface PaymentRow {
  payment: Payment;
  order: Order;
}

export interface PaymentFilter {
  status?: PaymentStatus | '';
  method?: PaymentMethod | '';
  channel?: Channel | '';
  branchId?: string;
  /** Matches the order number, reference, wallet or note. */
  query?: string;
}

/** Every payment, newest first, filtered. Void orders keep their payments for the record. */
export function paymentRows(orders: readonly Order[], filter: PaymentFilter = {}): PaymentRow[] {
  const query = filter.query?.trim().toLowerCase() ?? '';
  const rows = orders.flatMap((order) => order.payments.map((payment) => ({ payment, order })));
  return rows
    .filter(({ payment, order }) => {
      if (filter.status && payment.status !== filter.status) return false;
      if (filter.method && payment.method !== filter.method) return false;
      if (filter.channel && order.channel !== filter.channel) return false;
      if (filter.branchId && order.branchId !== filter.branchId) return false;
      if (query) {
        const haystack = [order.number, payment.reference, payment.wallet, payment.note].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .sort((a, b) => b.payment.createdAt - a.payment.createdAt);
}

export interface PaymentSummary {
  paid: Rupiah;
  fees: Rupiah;
  refunded: Rupiah;
  /** Paid minus fees and refunds: what reaches the bank or the drawer. */
  net: Rupiah;
  pending: number;
  pendingAmount: Rupiah;
  byMethod: Record<PaymentMethod, { count: number; amount: Rupiah; fees: Rupiah }>;
}

export function summarizePayments(rows: readonly PaymentRow[], refunds: readonly Refund[]): PaymentSummary {
  const byMethod = { cash: { count: 0, amount: 0, fees: 0 }, qris: { count: 0, amount: 0, fees: 0 }, card: { count: 0, amount: 0, fees: 0 }, ewallet: { count: 0, amount: 0, fees: 0 } };
  const summary: PaymentSummary = { paid: 0, fees: 0, refunded: 0, net: 0, pending: 0, pendingAmount: 0, byMethod };
  const orderIds = new Set<string>();
  for (const { payment, order } of rows) {
    if (payment.status === 'pending') {
      summary.pending += 1;
      summary.pendingAmount += payment.amount;
    }
    if (payment.status !== 'paid') continue;
    orderIds.add(order.id);
    const fee = payment.fee ?? 0;
    summary.paid += payment.amount;
    summary.fees += fee;
    byMethod[payment.method].count += 1;
    byMethod[payment.method].amount += payment.amount;
    byMethod[payment.method].fees += fee;
  }
  summary.refunded = refunds.filter((refund) => orderIds.has(refund.orderId)).reduce((sum, refund) => sum + refund.amount, 0);
  summary.net = summary.paid - summary.fees - summary.refunded;
  return summary;
}

// ---------- the payment report ----------

export type PaymentGroup = 'method' | 'day' | 'branch' | 'booth' | 'shift';

export interface PaymentReportRow {
  key: string;
  label: string;
  count: number;
  gross: Rupiah;
  fees: Rupiah;
  refunds: Rupiah;
  /** Gross minus fees and refunds. */
  net: Rupiah;
}

export interface PaymentReportInput {
  orders: readonly Order[];
  refunds: readonly Refund[];
  /** "YYYY-MM-DD" for a time, in the reporting zone. */
  dayOf(time: number): string;
  label(group: PaymentGroup, key: string): string;
}

/**
 * Paid payments grouped one way. A refund counts against the method it went back through, and
 * otherwise against the order it belongs to.
 */
export function paymentReport(input: PaymentReportInput, group: PaymentGroup): PaymentReportRow[] {
  const rows = new Map<string, PaymentReportRow>();
  const row = (key: string): PaymentReportRow => {
    let entry = rows.get(key);
    if (!entry) {
      entry = { key, label: input.label(group, key), count: 0, gross: 0, fees: 0, refunds: 0, net: 0 };
      rows.set(key, entry);
    }
    return entry;
  };
  const keyOf = (order: Order, payment: Payment): string => {
    if (group === 'method') return payment.method;
    if (group === 'day') return input.dayOf(payment.paidAt ?? payment.createdAt);
    if (group === 'branch') return order.branchId;
    if (group === 'booth') return order.boothId ?? 'cashier';
    return order.shiftId ?? 'no-shift';
  };
  const byId = new Map(input.orders.map((order) => [order.id, order]));
  for (const order of input.orders) {
    for (const payment of order.payments) {
      if (payment.status !== 'paid') continue;
      const entry = row(keyOf(order, payment));
      entry.count += 1;
      entry.gross += payment.amount;
      entry.fees += payment.fee ?? 0;
    }
  }
  for (const refund of input.refunds) {
    const order = byId.get(refund.orderId);
    if (!order) continue;
    const key = group === 'method' ? refund.method : group === 'day' ? input.dayOf(refund.at) : keyOf(order, order.payments[0] ?? { method: refund.method, createdAt: refund.at } as Payment);
    row(key).refunds += refund.amount;
  }
  for (const entry of rows.values()) entry.net = entry.gross - entry.fees - entry.refunds;
  return [...rows.values()].sort((a, b) => (group === 'day' ? b.key.localeCompare(a.key) : b.net - a.net));
}
