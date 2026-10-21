// Transactions: every order with its payments and refunds, every booth session, and the activity
// log of every rupiah, refund, voucher and shift.

import { formDialog, openDialog } from '../../../dialogs';
import { seesBranch } from '../../access';
import { lineGross, lineNet, paidAmount } from '../../cart';
import { PAYMENT_LABELS, SESSION_MODES, type Order } from '../../model';
import type { Ops } from '../../ops';
import { shiftSlip } from '../../shift';
import type { PageContext } from '../router';
import { act, actionButton, badge, dateTime, el, money, page, pills, table } from '../kit';
import { printReceipt, showSlip } from './pos';

type Tab = 'orders' | 'sessions' | 'refunds' | 'shifts' | 'activity';

const view = { tab: 'orders' as Tab, search: '', branchId: '' };

export function renderSales(context: PageContext): HTMLElement {
  const { ops, redraw } = context;
  const { state } = ops;
  const actor = ops.actor();
  const inScope = (branchId: string | null) => seesBranch(actor, branchId) && (!view.branchId || branchId === view.branchId);
  const query = view.search.trim().toLowerCase();
  const matches = (...texts: string[]) => !query || texts.some((text) => text.toLowerCase().includes(query));

  const root = page('Transactions', 'Sales, sessions, refunds, shifts and the activity log. Staff only see the branches they work at.');
  const filters = el('div', 'ops-filters');
  const branch = el('select', 'input select');
  branch.add(new Option('All branches', ''));
  for (const location of ops.visibleBranches()) branch.add(new Option(location.name, location.id, false, location.id === view.branchId));
  branch.addEventListener('change', () => {
    view.branchId = branch.value;
    redraw();
  });
  const search = el('input', 'input');
  search.type = 'search';
  search.placeholder = 'Search number, item, code, reason';
  search.value = view.search;
  search.addEventListener('change', () => {
    view.search = search.value;
    redraw();
  });
  filters.append(
    pills(
      [
        { value: 'orders', label: 'Orders' },
        { value: 'sessions', label: 'Sessions' },
        { value: 'refunds', label: 'Refunds' },
        { value: 'shifts', label: 'Shifts' },
        { value: 'activity', label: 'Activity log' },
      ] as const,
      view.tab,
      (tab) => {
        view.tab = tab;
        redraw();
      },
    ),
    branch,
    search,
  );
  root.body.append(filters);

  if (view.tab === 'orders') {
    const orders = state.orders.filter((order) => inScope(order.branchId) && matches(order.number, ...order.lines.map((line) => line.label), ...order.sessionVouchers, order.voucherCode ?? ''));
    root.body.append(
      table(
        [
          { label: 'Order', cell: (order) => order.number },
          { label: 'When', cell: (order) => dateTime(order.paidAt ?? order.createdAt) },
          { label: 'Where', cell: (order) => (order.channel === 'booth' ? ops.boothName(order.boothId) : `Till · ${ops.branchName(order.branchId)}`) },
          { label: 'Items', cell: (order) => order.lines.map((line) => `${line.qty}× ${line.label}`).join(', ') },
          { label: 'Paid by', cell: (order) => order.payments.filter((p) => p.status === 'paid').map((p) => PAYMENT_LABELS[p.method]).join(' + ') || '—' },
          { label: 'Total', className: 'num', cell: (order) => money(order.total) },
          { label: 'Status', cell: (order) => statusBadge(order) },
        ],
        orders.slice(0, 300),
        { empty: 'No orders yet.', onRow: (order) => orderDialog(ops, order.id) },
      ),
    );
  } else if (view.tab === 'sessions') {
    const sessions = state.sessions.filter((session) => inScope(session.branchId) && matches(ops.boothName(session.boothId), session.voucherCode ?? '', session.mode));
    root.body.append(
      table(
        [
          { label: 'Started', cell: (session) => dateTime(session.startedAt) },
          { label: 'Booth', cell: (session) => ops.boothName(session.boothId) },
          { label: 'Mode', cell: (session) => SESSION_MODES[session.mode].label },
          { label: 'Frame', cell: (session) => state.frames.find((frame) => frame.id === session.frameId)?.name ?? '—' },
          { label: 'Paid with', cell: (session) => session.voucherCode ?? (session.orderId ? state.orders.find((o) => o.id === session.orderId)?.number ?? '—' : session.price === 0 ? 'Free event' : '—') },
          { label: 'Price', className: 'num', cell: (session) => money(session.price) },
          { label: 'Files', className: 'num', cell: (session) => (session.purgedAt ? badge('Purged', 'muted') : String(session.shotIds.length)) },
          { label: 'Prints', className: 'num', cell: (session) => String(session.prints) },
          { label: 'Sharing', cell: (session) => badge(session.consent ? 'Allowed' : 'Private', session.consent ? 'ok' : 'muted') },
        ],
        sessions.slice(0, 300),
        { empty: 'No booth sessions yet.' },
      ),
    );
  } else if (view.tab === 'refunds') {
    const refunds = state.refunds.filter((refund) => {
      const order = state.orders.find((entry) => entry.id === refund.orderId);
      return inScope(order?.branchId ?? null) && matches(order?.number ?? '', refund.reason);
    });
    root.body.append(
      table(
        [
          { label: 'When', cell: (refund) => dateTime(refund.at) },
          { label: 'Order', cell: (refund) => state.orders.find((order) => order.id === refund.orderId)?.number ?? '—' },
          { label: 'Item', cell: (refund) => state.orders.find((order) => order.id === refund.orderId)?.lines.find((line) => line.id === refund.lineId)?.label ?? '—' },
          { label: 'Reason', cell: (refund) => refund.reason },
          { label: 'By', cell: (refund) => state.staff.find((person) => person.id === refund.staffId)?.name ?? '—' },
          { label: 'Approved by', cell: (refund) => state.staff.find((person) => person.id === refund.supervisorId)?.name ?? '—' },
          { label: 'Back via', cell: (refund) => PAYMENT_LABELS[refund.method] },
          { label: 'Amount', className: 'num', cell: (refund) => `−${money(refund.amount)}` },
        ],
        refunds,
        { empty: 'No refunds.' },
      ),
    );
  } else if (view.tab === 'shifts') {
    const shifts = state.shifts.filter((shift) => inScope(shift.branchId));
    root.body.append(
      table(
        [
          { label: 'Branch', cell: (shift) => ops.branchName(shift.branchId) },
          { label: 'Opened', cell: (shift) => dateTime(shift.openedAt) },
          { label: 'Closed', cell: (shift) => (shift.closedAt ? dateTime(shift.closedAt) : badge('Open', 'ok')) },
          { label: 'By', cell: (shift) => state.staff.find((person) => person.id === shift.staffId)?.name ?? '—' },
          { label: 'Net', className: 'num', cell: (shift) => money(shiftSlip(shift, state.orders, state.refunds).net) },
          {
            label: 'Drawer',
            className: 'num',
            cell: (shift) => {
              const variance = shiftSlip(shift, state.orders, state.refunds).variance;
              return variance === null ? '—' : badge(variance === 0 ? 'Matches' : `${variance > 0 ? '+' : ''}${money(variance)}`, variance === 0 ? 'ok' : 'warn');
            },
          },
        ],
        shifts,
        { empty: 'No shifts yet.', onRow: (shift) => showSlip(ops, shiftSlip(shift, state.orders, state.refunds), shift.id) },
      ),
    );
  } else {
    const entries = state.activity.filter((entry) => (!entry.branchId || inScope(entry.branchId)) && matches(entry.message, entry.kind));
    root.body.append(
      table(
        [
          { label: 'When', cell: (entry) => dateTime(entry.at) },
          { label: 'Who', cell: (entry) => state.staff.find((person) => person.id === entry.staffId)?.name ?? 'System' },
          { label: 'What', cell: (entry) => entry.message },
          { label: 'Amount', className: 'num', cell: (entry) => (entry.amount === undefined ? '' : money(entry.amount)) },
        ],
        entries.slice(0, 500),
        { empty: 'Nothing logged yet.' },
      ),
    );
  }
  return root.root;
}

function statusBadge(order: Order): HTMLElement {
  if (order.status === 'void') return badge('Void', 'muted');
  if (order.status === 'open') return badge('Waiting payment', 'warn');
  const refunded = order.lines.filter((line) => line.refunded).length;
  if (refunded === order.lines.length) return badge('Refunded', 'error');
  if (refunded) return badge('Part refunded', 'warn');
  return badge('Paid', 'ok');
}

/** One order: lines with per-item refund, payments, codes, receipt. */
function orderDialog(ops: Ops, orderId: string): void {
  const order = ops.order(orderId);
  const lines = el('div', 'cart-lines');
  for (const line of order.lines) {
    const row = el('div', 'cart-line');
    const text = el('div', 'cart-text');
    text.append(el('span', 'rank-name', `${line.qty}× ${line.label}`), el('span', 'rank-meta', line.discount ? `${money(lineGross(line))} − ${money(line.discount)} discount` : money(lineGross(line))));
    row.append(text);
    if (line.refunded) row.append(badge('Refunded', 'error'));
    else if (order.status === 'paid' && ops.can('pos.sell')) {
      const refund = actionButton(`Refund ${money(lineNet(line))}`, 'btn btn-ghost btn-sm btn-danger');
      refund.addEventListener('click', () => {
        dialog.close();
        formDialog({
          title: `Refund ${line.label}`,
          description: `${money(lineNet(line))} goes back to the customer. A supervisor types their PIN to approve.`,
          submitLabel: 'Refund',
          fields: [
            { name: 'reason', label: 'Reason', value: '', placeholder: 'Print came out dark' },
            { name: 'pin', label: 'Supervisor PIN', value: '', type: 'password' },
          ],
          async submit(values) {
            await ops.refund(orderId, line.id, String(values.reason), String(values.pin));
          },
        });
      });
      row.append(refund);
    }
    lines.append(row);
  }
  const facts = el('dl', 'facts');
  const rows: [string, string][] = [
    ['When', dateTime(order.paidAt ?? order.createdAt)],
    ['Where', order.channel === 'booth' ? ops.boothName(order.boothId) : `Till · ${ops.branchName(order.branchId)}`],
    ['Cashier', ops.state.staff.find((person) => person.id === order.staffId)?.name ?? '—'],
    ['Subtotal', money(order.subtotal)],
    ['Discount', order.discount ? `−${money(order.discount)}${order.voucherCode ? ` (${order.voucherCode})` : ''}` : '—'],
    ['Total', money(order.total)],
    ['Paid', `${money(paidAmount(order.payments))} by ${order.payments.filter((p) => p.status === 'paid').map((p) => `${PAYMENT_LABELS[p.method]}${p.reference ? ` ${p.reference}` : ''}`).join(', ') || '—'}`],
    ['Queue', order.ticketNumbers.join(', ') || '—'],
    ['Session codes', order.sessionVouchers.join(', ') || '—'],
  ];
  for (const [label, value] of rows) facts.append(el('dt', '', label), el('dd', '', value));
  const print = act('Print receipt', 'btn btn-outline', () => printReceipt(ops, order), 'printer');
  const close = actionButton('Done', 'btn btn-primary');
  close.dataset.close = '';
  const dialog = openDialog({ title: order.number, body: [lines, facts], footer: [print, close] });
}
