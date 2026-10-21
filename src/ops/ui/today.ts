// The dashboard's business card: today's revenue per branch and booth, which booths are online,
// open alerts, the queue and cloud sync, scoped to the branches the person on this device sees.

import { seesBranch } from '../access';
import { paidAmount } from '../cart';
import type { Ops } from '../ops';
import { isOnline } from '../telemetry';
import { localTimeZone, zonedTime } from '../time';
import { badge, el, money, statRow } from './kit';
import type { View } from '../../ui';

export function renderToday(ops: Ops, nav: (view: View) => void): HTMLElement {
  const { state } = ops;
  const actor = ops.actor();
  const zone = localTimeZone();
  const today = zonedTime(Date.now(), zone).date;
  const orders = state.orders.filter((order) => order.status === 'paid' && seesBranch(actor, order.branchId) && zonedTime(order.paidAt ?? order.createdAt, zone).date === today);
  const refunds = state.refunds.filter((refund) => zonedTime(refund.at, zone).date === today && orders.some((order) => order.id === refund.orderId));
  const gross = orders.reduce((sum, order) => sum + paidAmount(order.payments), 0);
  const refunded = refunds.reduce((sum, refund) => sum + refund.amount, 0);
  /** Paid minus refunded, for the orders that match. */
  const net = (match: (order: (typeof orders)[number]) => boolean) =>
    orders.filter(match).reduce((sum, order) => sum + paidAmount(order.payments), 0) -
    refunds.filter((refund) => orders.some((order) => order.id === refund.orderId && match(order))).reduce((sum, refund) => sum + refund.amount, 0);
  const booths = ops.visibleBooths();
  const online = booths.filter((point) => isOnline(state.health.find((entry) => entry.boothId === point.id), Date.now())).length;
  const openAlerts = state.alerts.filter((alert) => !alert.resolvedAt && seesBranch(actor, alert.branchId));

  const card = el('section', 'card today-card');
  const head = el('header', 'card-head');
  const title = el('div');
  title.append(el('h2', 'card-title', 'Today'), el('p', 'card-desc', `Sales and booths for ${new Date().toLocaleDateString(undefined, { dateStyle: 'full' })}.`));
  head.append(title);
  const body = el('div', 'card-body');
  body.append(
    statRow([
      { label: 'Revenue', value: money(gross - refunded), hint: refunded ? `${money(refunded)} refunded` : `${orders.length} orders` },
      { label: 'Booths online', value: `${online} / ${booths.length}` },
      { label: 'Open alerts', value: String(openAlerts.length), hint: openAlerts[0]?.message ?? 'All clear' },
      { label: 'Waiting in queue', value: String(state.tickets.filter((ticket) => ticket.status === 'waiting').length), hint: `${ops.outbox.pending().length} items waiting to sync` },
    ]),
  );

  const grid = el('div', 'today-grid');
  const byBranch = el('div', 'rank-list');
  byBranch.append(el('p', 'kicker', 'By branch'));
  if (ops.visibleBranches().length === 0) byBranch.append(el('p', 'card-desc', 'No branches yet.'));
  for (const branch of ops.visibleBranches()) {
    const total = net((order) => order.branchId === branch.id);
    const row = el('div', 'today-row');
    row.append(el('span', 'rank-name', branch.name), el('span', 'rank-value', money(total)));
    byBranch.append(row);
  }
  const byBooth = el('div', 'rank-list');
  byBooth.append(el('p', 'kicker', 'By booth'));
  for (const point of booths) {
    const health = state.health.find((entry) => entry.boothId === point.id);
    // Booth revenue is what the booth itself took by QRIS; cashier sales count under their branch.
    const total = net((order) => order.boothId === point.id);
    const row = el('div', 'today-row');
    const name = el('span', 'rank-name', point.name);
    row.append(name, health ? (isOnline(health, Date.now()) ? badge('Online', 'ok') : badge('Offline', 'error')) : badge('No signal', 'muted'), el('span', 'rank-value', money(total)));
    byBooth.append(row);
  }
  if (booths.length === 0) byBooth.append(el('p', 'card-desc', 'No booths yet.'));
  grid.append(byBranch, byBooth);
  body.append(grid);

  const links = el('div', 'page-actions');
  for (const [label, view] of [['Point of sale', 'pos'], ['Transactions', 'sales'], ['Devices', 'devices']] as const) {
    const button = el('button', 'btn btn-outline btn-sm', label);
    button.type = 'button';
    button.addEventListener('click', () => nav(view));
    links.append(button);
  }
  body.append(links);
  card.append(head, body);
  return card;
}
