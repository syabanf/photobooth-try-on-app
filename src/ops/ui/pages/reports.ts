// Reports per day, branch, booth, shift, frame and mode with CSV and XLSX export, best sellers,
// and the settlement check of a gateway export against the ledger.

import { seesBranch } from '../../access';
import { xlsx } from '../../encoders';
import { SESSION_MODES, type SessionMode } from '../../model';
import { bestSellers, parseGatewayCsv, reconcileSettlement, revenueReport, toCsv, type GroupBy, type ReportRow, type Settlement } from '../../reports';
import { localTimeZone, zonedTime } from '../../time';
import type { PageContext } from '../router';
import { act, badge, downloadBytes, downloadText, el, fileInput, money, notice, page, pills, section, statRow, table } from '../kit';

const view = { groupBy: 'day' as GroupBy, from: '', to: '', settlement: null as Settlement | null, fileName: '' };

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
  root.body.append(best.root, settle.root);
  return root.root;
}
