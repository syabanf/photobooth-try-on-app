// Reports per day, branch, booth, shift, frame and mode with CSV and XLSX export, payments by
// method with fees, cash per shift, best sellers, and the settlement check of a gateway export
// against the ledger.

import { seesBranch } from '../../access';
import { xlsx } from '../../encoders';
import { PAYMENT_LABELS, PAYMENT_METHODS, SESSION_MODES, type PaymentMethod, type SessionMode } from '../../model';
import { paymentReport, type PaymentGroup } from '../../payments';
import { shiftSlip } from '../../shift';
import { bestSellers, parseGatewayCsv, reconcileSettlement, revenueReport, toCsv, type GroupBy, type ReportRow, type Settlement } from '../../reports';
import { localTimeZone, zonedTime } from '../../time';
import type { PageContext } from '../router';
import { act, badge, downloadBytes, downloadText, el, fileInput, money, notice, page, pills, section, statRow, table } from '../kit';

const view = { groupBy: 'day' as GroupBy, payGroup: 'method' as PaymentGroup, from: '', to: '', settlement: null as Settlement | null, fileName: '' };

const GROUPS: { value: GroupBy; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'branch', label: 'Branch' },
  { value: 'booth', label: 'Booth' },
  { value: 'shift', label: 'Shift' },
  { value: 'frame', label: 'Frame' },
  { value: 'mode', label: 'Mode' },
];

export function renderReports({ ops, redraw }: PageContext): HTMLElement {
  const { state } = ops;
  const zone = localTimeZone();
  const today = zonedTime(Date.now(), zone).date;
  if (!view.from) {
    view.to = today;
    view.from = zonedTime(Date.now() - 29 * 86_400_000, zone).date;
  }
  const inRange = (time: number) => {
    const date = zonedTime(time, zone).date;
    return date >= view.from && date <= view.to;
  };
  const actor = ops.actor();
  const orders = state.orders.filter((order) => seesBranch(actor, order.branchId) && inRange(order.paidAt ?? order.createdAt));
  const sessions = state.sessions.filter((session) => seesBranch(actor, session.branchId) && inRange(session.startedAt));
  const label = (groupBy: GroupBy, key: string): string => {
    if (groupBy === 'branch') return ops.branchName(key);
    if (groupBy === 'booth') return key === 'cashier' ? 'Till' : ops.boothName(key);
    if (groupBy === 'frame') return key === 'none' ? 'No frame' : (state.frames.find((frame) => frame.id === key)?.name ?? 'Deleted frame');
    if (groupBy === 'mode') return SESSION_MODES[key as SessionMode]?.label ?? key;
    if (groupBy === 'shift') {
      const shift = state.shifts.find((entry) => entry.id === key);
      return shift ? `${ops.branchName(shift.branchId)} · ${new Date(shift.openedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'No shift';
    }
    return key;
  };
  const rows = revenueReport({ orders, refunds: state.refunds, sessions, timeZone: zone, label }, view.groupBy);
  const totals = rows.reduce((sum, row) => ({ gross: sum.gross + row.gross, refunds: sum.refunds + row.refunds, net: sum.net + row.net }), { gross: 0, refunds: 0, net: 0 });

  const root = page('Reports', 'Revenue for the dates you pick, grouped the way you need. Exports open in Excel or Google Sheets.');

  // ---------- controls ----------
  const controls = el('div', 'ops-filters');
  const from = el('input', 'input');
  from.type = 'date';
  from.value = view.from;
  const to = el('input', 'input');
  to.type = 'date';
  to.value = view.to;
  for (const input of [from, to]) {
    input.addEventListener('change', () => {
      view.from = from.value || view.from;
      view.to = to.value || view.to;
      redraw();
    });
  }
  controls.append(pills(GROUPS, view.groupBy, (groupBy) => {
    view.groupBy = groupBy;
    redraw();
  }), from, to);
  const headers = ['Group', 'Orders', 'Sessions sold', 'Gross', 'Refunds', 'Net'];
  const cells = (row: ReportRow) => [row.label, row.orders, row.sessions, row.gross, row.refunds, row.net];
  const fileBase = `report-${view.groupBy}-${view.from}-to-${view.to}`;
  root.actions.append(
    act('CSV', 'btn btn-outline btn-sm', () => downloadText(toCsv(headers, rows.map(cells)), `${fileBase}.csv`), 'download'),
    act('XLSX', 'btn btn-outline btn-sm', () => downloadBytes(xlsx('Report', headers, rows.map(cells)), `${fileBase}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'download'),
  );
  root.body.append(
    controls,
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

  // ---------- payments ----------
  const refunds = state.refunds.filter((refund) => inRange(refund.at) && orders.some((order) => order.id === refund.orderId));
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

  // ---------- cash per shift ----------
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

  // ---------- best sellers ----------
  const best = section('Best sellers', 'By quantity, refunded lines left out. Frames rank by sessions in the Frame report above.');
  best.body.append(table([{ label: 'Item', cell: (row) => row.label }, { label: 'Sold', className: 'num', cell: (row) => String(row.qty) }, { label: 'Revenue', className: 'num', cell: (row) => money(row.revenue) }], bestSellers(orders).slice(0, 10), { empty: 'Nothing sold yet.' }));

  // ---------- settlement ----------
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
  root.body.append(pays.root, deposits.root, best.root, settle.root);
  return root.root;
}
