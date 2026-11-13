// Reports in six tabs over one date range: sales (by day, branch, booth, shift, frame or mode),
// products (sessions, AI presets, prints, merchandise and best sellers), payments by method with
// fees, cash per shift, the floor (queue, gate and AI prints), and the settlement check of a
// gateway export against the ledger. Every table exports to CSV, and sales and payments to XLSX.

import { seesBranch } from '../../access';
import { xlsx } from '../../encoders';
import { PAYMENT_LABELS, PAYMENT_METHODS, SESSION_MODES, type LineKind, type PaymentMethod, type SessionMode } from '../../model';
import { paymentReport, type PaymentGroup } from '../../payments';
import { shiftSlip } from '../../shift';
import { bestSellers, floorReport, parseGatewayCsv, PRODUCT_LABELS, reconcileSettlement, revenueReport, toCsv, type GroupBy, type ReportRow, type Settlement } from '../../reports';
import { localTimeZone, zonedTime } from '../../time';
import type { PageContext } from '../router';
import { act, badge, downloadBytes, downloadText, el, fileInput, money, notice, page, pills, section, statRow, table } from '../kit';

type Tab = 'sales' | 'products' | 'payments' | 'cash' | 'floor' | 'settlement';
type Range = 'today' | '7' | '30' | 'month' | 'custom';

const view = { tab: 'sales' as Tab, range: '30' as Range, groupBy: 'day' as GroupBy, payGroup: 'method' as PaymentGroup, from: '', to: '', settlement: null as Settlement | null, fileName: '' };

const TABS: { value: Tab; label: string }[] = [
  { value: 'sales', label: 'Sales' },
  { value: 'products', label: 'Products' },
  { value: 'payments', label: 'Payments' },
  { value: 'cash', label: 'Cash' },
  { value: 'floor', label: 'Floor' },
  { value: 'settlement', label: 'Settlement' },
];

const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: 'month', label: 'This month' },
  { value: 'custom', label: 'Custom' },
];

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const GROUPS: { value: GroupBy; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'branch', label: 'Branch' },
  { value: 'booth', label: 'Booth' },
  { value: 'shift', label: 'Shift' },
  { value: 'frame', label: 'Frame' },
  { value: 'mode', label: 'Mode' },
];

/** The first and last day a quick range covers, in this device's time zone. */
function rangeDates(range: Range, zone: string): { from: string; to: string } {
  const day = (offset: number) => zonedTime(Date.now() - offset * 86_400_000, zone).date;
  const today = day(0);
  if (range === 'today') return { from: today, to: today };
  if (range === '7') return { from: day(6), to: today };
  if (range === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: day(29), to: today };
}

export function renderReports({ ops, redraw }: PageContext): HTMLElement {
  const { state } = ops;
  const zone = localTimeZone();
  const today = zonedTime(Date.now(), zone).date;
  if (!view.from || view.range !== 'custom') Object.assign(view, rangeDates(view.range, zone));
  const inRange = (time: number) => {
    const date = zonedTime(time, zone).date;
    return date >= view.from && date <= view.to;
  };
  const actor = ops.actor();
  const orders = state.orders.filter((order) => seesBranch(actor, order.branchId) && inRange(order.paidAt ?? order.createdAt));
  const sessions = state.sessions.filter((session) => seesBranch(actor, session.branchId) && inRange(session.startedAt));
  const refunds = state.refunds.filter((refund) => inRange(refund.at) && orders.some((order) => order.id === refund.orderId));
  const label = (groupBy: GroupBy, key: string): string => {
    if (groupBy === 'branch') return ops.branchName(key);
    if (groupBy === 'booth') return key === 'cashier' ? 'Till' : ops.boothName(key);
    if (groupBy === 'product') return PRODUCT_LABELS[key as LineKind] ?? key;
    if (groupBy === 'frame') return key === 'none' ? 'No frame' : (state.frames.find((frame) => frame.id === key)?.name ?? 'Deleted frame');
    if (groupBy === 'mode') return SESSION_MODES[key as SessionMode]?.label ?? key;
    if (groupBy === 'shift') {
      const shift = state.shifts.find((entry) => entry.id === key);
      return shift ? `${ops.branchName(shift.branchId)} · ${new Date(shift.openedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'No shift';
    }
    return key;
  };
  const revenue = (groupBy: GroupBy) => revenueReport({ orders, refunds: state.refunds, sessions, timeZone: zone, label }, groupBy);
  const sum = (rows: ReportRow[]) => rows.reduce((total, row) => ({ gross: total.gross + row.gross, refunds: total.refunds + row.refunds, net: total.net + row.net }), { gross: 0, refunds: 0, net: 0 });
  const exports = (actions: HTMLElement, name: string, headers: string[], rows: (string | number)[][], sheet?: string) => {
    actions.append(act('CSV', 'btn btn-outline btn-sm', () => downloadText(toCsv(headers, rows), `${name}-${view.from}-to-${view.to}.csv`), 'download'));
    if (sheet) actions.append(act('XLSX', 'btn btn-outline btn-sm', () => downloadBytes(xlsx(sheet, headers, rows), `${name}-${view.from}-to-${view.to}.xlsx`, XLSX_TYPE), 'download'));
  };

  const root = page('Reports', 'Pick the dates once; every tab reads the same range. Exports open in Excel or Google Sheets.');

  // ---------- the range and the tabs ----------
  const controls = el('div', 'ops-filters');
  const from = el('input', 'input');
  from.type = 'date';
  from.value = view.from;
  from.setAttribute('aria-label', 'From');
  const to = el('input', 'input');
  to.type = 'date';
  to.value = view.to;
  to.setAttribute('aria-label', 'To');
  for (const input of [from, to]) {
    input.addEventListener('change', () => {
      view.range = 'custom';
      view.from = from.value || view.from;
      view.to = to.value || view.to;
      redraw();
    });
  }
  const dates = el('div', 'date-range');
  dates.append(from, to);
  controls.append(pills(RANGES, view.range, (range) => {
    view.range = range;
    redraw();
  }), dates);
  root.body.append(
    pills(TABS, view.tab, (tab) => {
      view.tab = tab;
      redraw();
    }),
    controls,
  );

  const tabs: Record<Tab, () => HTMLElement[]> = { sales: salesTab, products: productsTab, payments: paymentsTab, cash: cashTab, floor: floorTab, settlement: settlementTab };
  root.body.append(...tabs[view.tab]());
  return root.root;

  // ---------- sales ----------
  function salesTab(): HTMLElement[] {
    const rows = revenue(view.groupBy);
    const totals = sum(rows);
    const headers = ['Group', 'Orders', 'Sessions sold', 'Gross', 'Refunds', 'Net'];
    const sales = section('Sales', 'Revenue grouped the way you need. Frame and mode count booth sessions at their price.');
    exports(sales.actions, `sales-${view.groupBy}`, headers, rows.map((row) => [row.label, row.orders, row.sessions, row.gross, row.refunds, row.net]), 'Sales');
    sales.body.append(
      pills(GROUPS, view.groupBy, (groupBy) => {
        view.groupBy = groupBy;
        redraw();
      }),
      statRow([
        { label: 'Gross', value: money(totals.gross) },
        { label: 'Refunds', value: money(totals.refunds) },
        { label: 'Net', value: money(totals.net) },
        { label: 'Booth sessions', value: String(sessions.length), hint: `${orders.filter((o) => o.status === 'paid').length} paid orders` },
      ]),
      table(
        [
          { label: GROUPS.find((group) => group.value === view.groupBy)!.label, cell: (row) => row.label },
          { label: 'Orders', className: 'num', cell: (row) => String(row.orders) },
          { label: 'Sessions sold', className: 'num', cell: (row) => String(row.sessions) },
          { label: 'Gross', className: 'num', cell: (row) => money(row.gross) },
          { label: 'Refunds', className: 'num', cell: (row) => (row.refunds ? `−${money(row.refunds)}` : '—') },
          { label: 'Net', className: 'num', cell: (row) => money(row.net) },
        ],
        rows,
        { empty: 'No sales in these dates.' },
      ),
    );
    return [sales.root];
  }

  // ---------- products ----------
  function productsTab(): HTMLElement[] {
    const rows = revenue('product');
    const totals = sum(rows);
    const products = section('What sold', 'Each kind of thing sold, from the order lines: photo sessions, AI presets (booth and kiosk), extra prints, reprints and merchandise. Refunds land on the line given back.');
    exports(products.actions, 'products', ['Product', 'Orders', 'Gross', 'Refunds', 'Net', 'Share of net'], rows.map((row) => [row.label, row.orders, row.gross, row.refunds, row.net, totals.net ? Math.round((row.net / totals.net) * 100) : 0]), 'Products');
    products.body.append(
      statRow(rows.slice(0, 4).map((row) => ({ label: row.label, value: money(row.net), hint: `${totals.net ? Math.round((row.net / totals.net) * 100) : 0}% of net · ${row.orders} orders` }))),
      table(
        [
          { label: 'Product', cell: (row) => row.label },
          { label: 'Orders', className: 'num', cell: (row) => String(row.orders) },
          { label: 'Gross', className: 'num', cell: (row) => money(row.gross) },
          { label: 'Refunds', className: 'num', cell: (row) => (row.refunds ? `−${money(row.refunds)}` : '—') },
          { label: 'Net', className: 'num', cell: (row) => money(row.net) },
          { label: 'Share', className: 'num', cell: (row) => `${totals.net ? Math.round((row.net / totals.net) * 100) : 0}%` },
        ],
        rows,
        { empty: 'No sales in these dates.' },
      ),
    );
    const top = bestSellers(orders).slice(0, 10);
    const best = section('Best sellers', 'The ten items sold most, by quantity, refunded lines left out. Frames rank by sessions under Sales → Frame.');
    exports(best.actions, 'best-sellers', ['Item', 'Sold', 'Revenue'], top.map((row) => [row.label, row.qty, row.revenue]));
    best.body.append(table([{ label: 'Item', cell: (row) => row.label }, { label: 'Sold', className: 'num', cell: (row) => String(row.qty) }, { label: 'Revenue', className: 'num', cell: (row) => money(row.revenue) }], top, { empty: 'Nothing sold yet.' }));
    return [products.root, best.root];
  }

  // ---------- payments ----------
  function paymentsTab(): HTMLElement[] {
    const payRows = paymentReport(
      { orders, refunds, dayOf: (time) => zonedTime(time, zone).date, label: (group, key) => (group === 'method' ? PAYMENT_LABELS[key as PaymentMethod] : label(group, key)) },
      view.payGroup,
    );
    const payTotals = payRows.reduce((sum, row) => ({ count: sum.count + row.count, gross: sum.gross + row.gross, fees: sum.fees + row.fees, refunds: sum.refunds + row.refunds, net: sum.net + row.net }), { count: 0, gross: 0, fees: 0, refunds: 0, net: 0 });
    const PAY_GROUPS: { value: PaymentGroup; label: string }[] = [
      { value: 'method', label: 'Method' },
      { value: 'day', label: 'Day' },
      { value: 'branch', label: 'Branch' },
      { value: 'booth', label: 'Booth' },
      { value: 'shift', label: 'Shift' },
    ];
    const pays = section('Payments', 'What came in by each method, the processing fees it cost, and what reaches the bank or the drawer after refunds. Same dates as above.');
    const payHeaders = ['Group', 'Payments', 'Gross', 'Fees', 'Refunds', 'Net'];
    const payCells = (row: (typeof payRows)[number]) => [row.label, row.count, row.gross, row.fees, row.refunds, row.net];
    const payFile = `payments-${view.payGroup}-${view.from}-to-${view.to}`;
    pays.actions.append(
      act('CSV', 'btn btn-outline btn-sm', () => downloadText(toCsv(payHeaders, payRows.map(payCells)), `${payFile}.csv`), 'download'),
      act('XLSX', 'btn btn-outline btn-sm', () => downloadBytes(xlsx('Payments', payHeaders, payRows.map(payCells)), `${payFile}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'download'),
    );
    pays.body.append(
      pills(PAY_GROUPS, view.payGroup, (group) => {
        view.payGroup = group;
        redraw();
      }),
      statRow([
        ...PAYMENT_METHODS.map((method) => {
          const row = paymentReport({ orders, refunds, dayOf: () => '', label: () => '' }, 'method').find((entry) => entry.key === method);
          return { label: PAYMENT_LABELS[method], value: money(row?.gross ?? 0), hint: row ? `${row.count} payments · fees ${money(row.fees)}` : 'None' };
        }),
      ]),
      table(
        [
          { label: PAY_GROUPS.find((group) => group.value === view.payGroup)!.label, cell: (row) => row.label },
          { label: 'Payments', className: 'num', cell: (row) => String(row.count) },
          { label: 'Gross', className: 'num', cell: (row) => money(row.gross) },
          { label: 'Fees', className: 'num', cell: (row) => (row.fees ? `−${money(row.fees)}` : '—') },
          { label: 'Refunds', className: 'num', cell: (row) => (row.refunds ? `−${money(row.refunds)}` : '—') },
          { label: 'Net', className: 'num', cell: (row) => money(row.net) },
        ],
        payRows,
        { empty: 'No payments in these dates.' },
      ),
      el('p', 'field-hint', `${payTotals.count} payments · gross ${money(payTotals.gross)} · fees ${money(payTotals.fees)} · refunds ${money(payTotals.refunds)} · net ${money(payTotals.net)}`),
    );
    return [pays.root];
  }

  // ---------- cash ----------
  function cashTab(): HTMLElement[] {
    const shifts = state.shifts.filter((shift) => seesBranch(actor, shift.branchId) && inRange(shift.openedAt)).sort((a, b) => b.openedAt - a.openedAt);
    const deposits = section('Cash per shift', 'The drawer at the end of each shift: what should be in it, what was counted, and the difference. Open shifts show the expected amount so far.');
    const slips = shifts.map((shift) => ({ shift, slip: shiftSlip(shift, state.orders, state.refunds) }));
    const depositHeaders = ['Branch', 'Opened', 'Closed', 'Opening cash', 'Cash in', 'Cash refunds', 'Expected', 'Counted', 'Difference'];
    const depositCells = ({ shift, slip }: (typeof slips)[number]) => [ops.branchName(shift.branchId), new Date(shift.openedAt).toISOString(), shift.closedAt ? new Date(shift.closedAt).toISOString() : '', slip.openingCash, slip.byMethod.cash, slip.refundsByMethod.cash, slip.expectedCash, slip.countedCash ?? '', slip.variance ?? ''];
    deposits.actions.append(act('CSV', 'btn btn-outline btn-sm', () => downloadText(toCsv(depositHeaders, slips.map(depositCells)), `cash-shifts-${view.from}-to-${view.to}.csv`), 'download'));
    deposits.body.append(
      table(
        [
          { label: 'Branch', cell: ({ shift }: (typeof slips)[number]) => ops.branchName(shift.branchId) },
          { label: 'Opened', cell: ({ shift }) => new Date(shift.openedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) },
          { label: 'Closed', cell: ({ shift }) => (shift.closedAt ? new Date(shift.closedAt).toLocaleTimeString(undefined, { timeStyle: 'short' }) : badge('Open', 'ok')) },
          { label: 'Opening', className: 'num', cell: ({ slip }) => money(slip.openingCash) },
          { label: 'Cash in', className: 'num', cell: ({ slip }) => money(slip.byMethod.cash) },
          { label: 'Cash refunds', className: 'num', cell: ({ slip }) => (slip.refundsByMethod.cash ? `−${money(slip.refundsByMethod.cash)}` : '—') },
          { label: 'Expected', className: 'num', cell: ({ slip }) => money(slip.expectedCash) },
          { label: 'Counted', className: 'num', cell: ({ slip }) => (slip.countedCash === null ? '—' : money(slip.countedCash)) },
          { label: 'Difference', className: 'num', cell: ({ slip }) => (slip.variance === null ? '—' : badge(slip.variance === 0 ? 'Matches' : `${slip.variance > 0 ? '+' : ''}${money(slip.variance)}`, slip.variance === 0 ? 'ok' : 'warn')) },
        ],
        slips,
        { empty: 'No shifts in these dates.' },
      ),
    );
    return [deposits.root];
  }

  // ---------- floor ----------
  function floorTab(): HTMLElement[] {
    const tickets = state.tickets.filter((ticket) => inRange(ticket.createdAt) && ticket.boothIds.some((boothId) => seesBranch(actor, ops.branchOf(boothId))));
    const faces = state.faces.filter((face) => inRange(face.createdAt) && seesBranch(actor, ops.branchOf(face.boothId)));
    const floor = floorReport({ tickets, faces, orders, timeZone: zone });
    const report = section('Floor', 'How the day ran on the floor: the queue, the gate camera, and the AI prints parties bought at the booth or the kiosk.');
    exports(report.actions, 'floor-by-hour', ['Hour', 'Tickets'], floor.byHour.map((count, hour) => [`${String(hour).padStart(2, '0')}:00`, count]));
    const busiest = Math.max(...floor.byHour);
    const chart = el('div', 'hour-bars');
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', `Tickets by hour; the busiest hour had ${busiest}.`);
    for (const [hour, count] of floor.byHour.entries()) {
      if (hour < 7 || hour > 22) continue;
      const bar = el('div', 'hour-bar');
      const fill = el('span', `hour-bar-fill${count === busiest && busiest > 0 ? ' is-peak' : ''}`);
      fill.style.height = `${busiest ? (count / busiest) * 100 : 0}%`;
      bar.title = `${String(hour).padStart(2, '0')}:00 · ${count} tickets`;
      bar.append(el('span', 'hour-bar-count', count ? String(count) : ''), fill, el('span', 'hour-bar-label', String(hour).padStart(2, '0')));
      chart.append(bar);
    }
    report.body.append(
      statRow([
        { label: 'Tickets', value: String(floor.tickets), hint: `${floor.served} served · ${floor.skipped} skipped` },
        { label: 'Average wait', value: floor.averageWait === null ? '—' : `${Math.round(floor.averageWait)} min`, hint: 'Ticket to call' },
        { label: 'Parties photographed', value: String(floor.partiesPhotographed), hint: `${floor.faces} faces at the gate` },
        { label: 'AI prints', value: String(floor.presetPrints), hint: floor.partiesPhotographed ? `${(floor.presetPrints / floor.partiesPhotographed).toFixed(1)} per party · ${money(floor.presetRevenue)}` : money(floor.presetRevenue) },
      ]),
      el('p', 'kicker', 'Tickets by hour, 07:00 to 22:00'),
      chart,
    );
    return [report.root];
  }

  // ---------- settlement ----------
  function settlementTab(): HTMLElement[] {
    const settle = section('Settlement', 'Upload the QRIS settlement export from your gateway to match it against the payments recorded here.');
    const upload = fileInput('.csv,text/csv', async (file) => {
      try {
        const rowsIn = parseGatewayCsv(await file.text());
        const payments = state.orders.flatMap((order) => order.payments);
        view.settlement = reconcileSettlement(payments, rowsIn);
        view.fileName = file.name;
        redraw();
      } catch (error) {
        notice((error as Error).message, 'error');
      }
    });
    settle.actions.append(upload, act('Upload export', 'btn btn-outline btn-sm', () => upload.click(), 'upload'));
    const result = view.settlement;
    if (!result) {
      settle.body.append(el('p', 'card-desc', 'The file needs a reference (order_id) and amount (gross_amount) column; status and fee are read when present.'));
    } else {
      settle.body.append(
        el('p', 'card-desc', view.fileName),
        statRow([
          { label: 'Matched', value: String(result.matched.length) },
          { label: 'Amount differs', value: String(result.mismatched.length) },
          { label: 'Only at the gateway', value: String(result.missingInLedger.length) },
          { label: 'Only in the ledger', value: String(result.missingInGateway.length) },
        ]),
        el('p', 'card-desc', `Ledger ${money(result.ledgerTotal)} · gateway ${money(result.gatewayTotal)} · fees ${money(result.fees)} · difference ${money(result.gatewayTotal - result.ledgerTotal)}`),
        table(
          [
            { label: 'Reference', cell: (row: { reference: string; problem: string; ledger: string; gateway: string }) => row.reference },
            { label: 'Problem', cell: (row) => badge(row.problem, 'warn') },
            { label: 'Ledger', className: 'num', cell: (row) => row.ledger },
            { label: 'Gateway', className: 'num', cell: (row) => row.gateway },
          ],
          [
            ...result.mismatched.map((row) => ({ reference: row.reference, problem: 'Amount differs', ledger: money(row.ledger), gateway: money(row.gateway) })),
            ...result.missingInLedger.map((row) => ({ reference: row.reference, problem: 'Not in the ledger', ledger: '—', gateway: money(row.amount) })),
            ...result.missingInGateway.map((payment) => ({ reference: payment.reference, problem: 'Not settled', ledger: money(payment.amount), gateway: '—' })),
          ],
          { empty: 'Everything matches.' },
        ),
      );
      settle.actions.append(
        act('Export result', 'btn btn-ghost btn-sm', () =>
          downloadText(
            toCsv(['Reference', 'Problem', 'Ledger', 'Gateway'], [
              ...result.matched.map((row) => [row.reference, 'Matched', row.amount, row.amount]),
              ...result.mismatched.map((row) => [row.reference, 'Amount differs', row.ledger, row.gateway]),
              ...result.missingInLedger.map((row) => [row.reference, 'Not in the ledger', '', row.amount]),
              ...result.missingInGateway.map((payment) => [payment.reference, 'Not settled', payment.amount, '']),
            ]),
            `settlement-${today}.csv`,
          ),
        'download'),
      );
    }
    return [settle.root];
  }
}
