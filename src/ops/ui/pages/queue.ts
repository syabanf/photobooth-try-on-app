// The queue desk: issue tickets, call the next customer per booth, re-call, mark served or
// no-show, put a late customer back, and drag to reorder. The TV display follows every change.

import { formDialog, openDialog } from '../../../dialogs';
import { iconButton } from '../../../icons';
import type { Ticket } from '../../model';
import { queueFor } from '../../queue';
import type { PageContext } from '../router';
import { act, actionButton, badge, el, notice, page, qrCanvas, section } from '../kit';

export function renderQueue({ ops }: PageContext): HTMLElement {
  const { tickets } = ops.state;
  const booths = ops.visibleBooths().filter((point) => point.active);
  const view = page('Queue', 'One ticket can wait for several booths. The first booth to free up calls it, and it leaves every other line.');
  view.actions.append(
    act('Issue ticket', 'btn btn-primary', () => issueDialog(ops, booths.map((b) => ({ id: b.id, name: b.name }))), 'ticket'),
    act('TV display', 'btn btn-outline', () => window.open(`${location.pathname}#display=queue`, 'vto-queue-tv', 'popup,width=1280,height=720'), 'tv'),
  );

  if (booths.length === 0) {
    view.body.append(el('p', 'card-desc', 'Add active booths on the Locations page to run a queue.'));
    return view.root;
  }

  // ---------- booths ----------
  const desk = el('div', 'queue-desk');
  for (const booth of booths) {
    const card = el('section', 'queue-booth');
    const now = tickets.find((ticket) => ticket.status === 'called' && ticket.calledBoothId === booth.id);
    const waiting = queueFor(tickets, booth.id);
    card.append(el('p', 'kicker', booth.name), el('p', 'queue-now', now ? now.number : '—'), el('p', 'card-desc', `${waiting.filter((t) => t.checkedIn).length} waiting · ${waiting.filter((t) => !t.checkedIn).length} not checked in`));
    const actions = el('div', 'queue-actions');
    if (now) {
      actions.append(
        act('Re-call', 'btn btn-outline btn-sm', () => ops.recall(now.id), 'megaphone'),
        act('Served', 'btn btn-secondary btn-sm', () => ops.completeTicket(now.id), 'check'),
        act('No-show', 'btn btn-ghost btn-sm', () => ops.skipTicket(now.id)),
      );
    }
    actions.append(
      act('Call next', 'btn btn-primary btn-sm', () => {
        const called = ops.callNext(booth.id);
        notice(called ? `${called.number} to ${booth.name}.` : 'Nobody checked in is waiting for this booth.', called ? 'ok' : 'warn');
      }),
    );
    card.append(actions);
    desk.append(card);
  }

  // ---------- waiting line, drag to reorder ----------
  const line = section('Waiting', 'Drag a ticket to move it. Unchecked tickets keep their place but are skipped until they check in.');
  const list = el('ol', 'queue-line');
  const waiting = tickets.filter((ticket) => ticket.status === 'waiting' && ticket.boothIds.some((id) => booths.some((b) => b.id === id))).sort((a, b) => a.position - b.position);
  let dragged: string | null = null;
  for (const ticket of waiting) {
    const item = el('li', 'queue-ticket');
    item.draggable = true;
    item.dataset.id = ticket.id;
    item.addEventListener('dragstart', () => {
      dragged = ticket.id;
      item.classList.add('is-dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('is-dragging'));
    item.addEventListener('dragover', (event) => event.preventDefault());
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      if (dragged && dragged !== ticket.id) ops.moveTicket(dragged, ticket.id);
    });
    const grip = el('span', 'queue-grip');
    grip.append(iconButton('grip', 'Drag to reorder'));
    const text = el('div', 'rank-text');
    text.append(el('span', 'queue-number', ticket.number), el('span', 'rank-meta', [ticket.name, ticket.boothIds.map((id) => ops.boothName(id)).join(' / ')].filter(Boolean).join(' · ')));
    const up = iconButton('arrowUp', `Move ${ticket.number} up`);
    up.addEventListener('click', () => {
      const index = waiting.indexOf(ticket);
      if (index > 0) ops.moveTicket(ticket.id, waiting[index - 1].id);
    });
    const show = iconButton('qr', `Show ${ticket.number}`);
    show.addEventListener('click', () => ticketDialog(ticket));
    item.append(grip, text, ticket.checkedIn ? badge('Checked in', 'ok') : badge('Not here yet', 'warn'), up, show);
    list.append(item);
  }
  list.addEventListener('dragover', (event) => event.preventDefault());
  list.addEventListener('drop', (event) => {
    if ((event.target as Element) === list && dragged) ops.moveTicket(dragged, null);
  });
  if (waiting.length === 0) list.append(el('li', 'card-desc', 'Nobody is waiting.'));
  line.body.append(list);

  // ---------- skipped: re-register ----------
  const late = section('Missed their call', 'Put a late customer back, at the front or the back of the line.');
  const skipped = tickets.filter((ticket) => ticket.status === 'skipped').slice(-10).reverse();
  const lateList = el('div', 'queue-late');
  for (const ticket of skipped) {
    const row = el('div', 'cart-line');
    row.append(el('span', 'queue-number', ticket.number), el('span', 'rank-meta', ticket.name || ''), act('Front', 'btn btn-outline btn-sm', () => ops.reRegister(ticket.id, 'front')), act('Back', 'btn btn-ghost btn-sm', () => ops.reRegister(ticket.id, 'back')));
    lateList.append(row);
  }
  if (skipped.length === 0) lateList.append(el('p', 'card-desc', 'No missed tickets.'));
  late.body.append(lateList);

  view.body.append(desk, line.root, late.root);
  return view.root;
}

function issueDialog(ops: PageContext['ops'], booths: { id: string; name: string }[]): void {
  formDialog({
    title: 'Issue ticket',
    description: 'Tick every booth the customer would take. A WhatsApp number or email gets a message when they are called.',
    submitLabel: 'Issue',
    fields: [
      { name: 'boothIds', label: 'Booths', value: booths.map((booth) => booth.id), options: booths.map((booth) => ({ value: booth.id, label: booth.name })) },
      { name: 'name', label: 'Name', value: '', placeholder: 'Optional' },
      { name: 'phone', label: 'WhatsApp', value: '', type: 'tel', placeholder: '+62…' },
      { name: 'email', label: 'Email', value: '', type: 'email' },
      { name: 'checkedIn', label: 'Customer is here', value: true, hint: 'Off for a booking: they check in by scanning the ticket QR when they arrive.' },
    ],
    async submit(values) {
      const ticket = ops.issueTicket({
        boothIds: values.boothIds as string[],
        name: String(values.name).trim(),
        phone: String(values.phone).trim(),
        email: String(values.email).trim(),
        checkedIn: values.checkedIn as boolean,
      });
      setTimeout(() => ticketDialog(ticket));
    },
  });
}

/** The digital ticket: number and the self check-in QR. */
function ticketDialog(ticket: Ticket): void {
  const link = `${location.origin}${location.pathname}#checkin=${ticket.token}`;
  const body = el('div', 'ticket-card');
  body.append(el('p', 'display-queue', ticket.number), qrCanvas(link, 200), el('p', 'card-desc', ticket.checkedIn ? 'Scan to see your place in line.' : 'Scan when you arrive to check in.'));
  const open = actionButton('Open check-in page', 'btn btn-outline');
  open.addEventListener('click', () => window.open(link, '_blank'));
  const done = actionButton('Done', 'btn btn-primary');
  done.dataset.close = '';
  openDialog({ title: `Ticket ${ticket.number}`, body: [body], footer: [open, done] });
}
