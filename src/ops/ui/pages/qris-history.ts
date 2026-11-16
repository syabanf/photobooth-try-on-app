// The trail of a shop's own QRIS: every notification the phone forwarded to the booth computer,
// what each one settled, and the QRs still waiting. Staff place a notification the amounts could
// not match, set one aside, or free a waiting QR. Served by scripts/qris-mutations.mjs, which
// answers these questions only on the booth computer itself.

import { formDialog, openDialog } from '../../../dialogs';
import { toCsv } from '../../reports';
import type { PageContext } from '../router';
import { act, actionButton, badge, dateTime, downloadText, el, money, notice, pills, section, statRow, table, type BadgeKind } from '../kit';

type Status = 'matched' | 'unmatched' | 'ignored';

interface Notification {
  id: string;
  at: number;
  text: string;
  amounts: number[];
  status: Status;
  /** The QR it settled: `<device>:<payment reference>`. */
  key?: string;
  total?: number;
  byHand?: boolean;
}

interface WaitingQr {
  key: string;
  amount: number;
  code: number;
  total: number;
  expiresAt: number;
}

export interface QrisDeskState {
  token: string;
  origin: string;
  lastSeen: number | null;
  /** When the phone last reached the booth computer: a notification or its regular ping. */
  lastContact: number | null;
  waiting: WaitingQr[];
  log: Notification[];
}

const STATUS_LABELS: Record<Status, string> = { matched: 'Matched', unmatched: 'Unmatched', ignored: 'Ignored' };
const STATUS_KIND: Record<Status, BadgeKind> = { matched: 'ok', unmatched: 'warn', ignored: 'muted' };
const view = { status: '' as Status | '', query: '' };

/** The payment reference inside a QR's key, without the device that showed it. */
const reference = (key: string) => key.slice(key.indexOf(':') + 1);

/** The booth computer's QRIS state, or the reason this device cannot see it. */
export async function loadQrisDesk(): Promise<QrisDeskState | string> {
  const reply = await fetch('/api/qris/setup').catch(() => null);
  if (!reply) return 'The booth computer did not answer. Your own QRIS needs the app opened from the booth computer (pnpm serve).';
  const data = (await reply.json().catch(() => ({}))) as QrisDeskState & { error?: string };
  return reply.ok ? data : (data.error ?? 'Open this page on the booth computer.');
}

async function post(path: string, body?: unknown): Promise<void> {
  const reply = await fetch(`/api/qris/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  if (!reply.ok) throw new Error(((await reply.json().catch(() => ({}))) as { error?: string }).error ?? 'The booth computer refused that.');
}

export function qrisHistoryTab({ ops, redraw }: PageContext): HTMLElement {
  const box = el('div', 'ops-body');
  box.append(el('p', 'card-desc', 'Checking the booth computer…'));
  void loadQrisDesk().then((desk) => {
    if (typeof desk === 'string') return box.replaceChildren(el('p', 'callout', desk));
    box.replaceChildren(history(desk), waitingQrs(desk));
  });
  return box;

  function history(desk: QrisDeskState): HTMLElement {
    const part = section('QRIS notifications', 'Every "money received" notification the phone forwarded, newest first, and the QR each one settled. The booth computer keeps the last 500.');
    const today = new Date().setHours(0, 0, 0, 0);
    const recent = desk.log.filter((entry) => entry.at >= today);
    const matched = recent.filter((entry) => entry.status === 'matched');
    const open = desk.log.filter((entry) => entry.status === 'unmatched');
    const query = view.query.trim().toLowerCase();
    const rows = desk.log.filter((entry) => (!view.status || entry.status === view.status) && (!query || `${entry.text} ${entry.key ?? ''} ${entry.amounts.join(' ')}`.toLowerCase().includes(query)));

    const search = el('input', 'input');
    search.type = 'search';
    search.placeholder = 'Text, amount or reference';
    search.value = view.query;
    search.addEventListener('change', () => {
      view.query = search.value;
      redraw();
    });
    const filters = el('div', 'ops-filters');
    filters.append(
      pills([{ value: '', label: 'All' }, ...(Object.keys(STATUS_LABELS) as Status[]).map((status) => ({ value: status, label: STATUS_LABELS[status] }))], view.status, (status) => {
        view.status = status;
        redraw();
      }),
      search,
      act('CSV', 'btn btn-outline btn-sm', () =>
        downloadText(
          toCsv(
            ['When', 'Status', 'Amounts read', 'Settled QR', 'Total', 'By hand', 'Text'],
            rows.map((entry) => [new Date(entry.at).toISOString(), STATUS_LABELS[entry.status], entry.amounts.join(' '), entry.key ? reference(entry.key) : '', entry.total ?? '', entry.byHand ? 'yes' : '', entry.text]),
          ),
          'qris-notifications.csv',
        ),
      'download'),
      act('Refresh', 'btn btn-ghost btn-sm', redraw),
    );

    part.body.append(
      statRow([
        { label: 'Received today', value: String(recent.length), hint: desk.lastSeen ? `Last at ${new Date(desk.lastSeen).toLocaleTimeString(undefined, { timeStyle: 'short' })}` : 'None yet' },
        { label: 'Matched today', value: money(matched.reduce((sum, entry) => sum + (entry.total ?? 0), 0)), hint: `${matched.length} payments` },
        { label: 'Unmatched', value: String(open.length), hint: open.length ? 'Open each one to place it' : 'Nothing to look at' },
        { label: 'QRs waiting now', value: String(desk.waiting.length) },
      ]),
      filters,
      table<Notification>(
        [
          { label: 'When', cell: (entry) => dateTime(entry.at) },
          { label: 'Status', cell: (entry) => badge(STATUS_LABELS[entry.status], STATUS_KIND[entry.status]) },
          { label: 'Amounts read', cell: (entry) => entry.amounts.map(money).join(', ') || 'None' },
          { label: 'Settled QR', cell: (entry) => (entry.key ? `${reference(entry.key)} · ${money(entry.total ?? 0)}${entry.byHand ? ' · by hand' : ''}` : '—') },
          { label: 'Text', cell: (entry) => entry.text },
          { label: '', cell: (entry) => act(entry.status === 'unmatched' ? 'Place it' : 'View', entry.status === 'unmatched' ? 'btn btn-outline btn-sm' : 'btn btn-ghost btn-sm', () => notificationDialog(entry, desk)) },
        ],
        rows,
        { empty: desk.log.length ? 'No notification fits these filters.' : 'No notification has arrived yet. Send a test from the QRIS gateway tab.' },
      ),
    );
    return part.root;
  }

  function notificationDialog(entry: Notification, desk: QrisDeskState): void {
    const facts = el('dl', 'facts');
    for (const [label, value] of [
      ['Received', dateTime(entry.at)],
      ['Status', `${STATUS_LABELS[entry.status]}${entry.byHand ? ' by hand' : ''}`],
      ['Amounts read', entry.amounts.map(money).join(', ') || 'None'],
      ['Settled QR', entry.key ? `${reference(entry.key)} · ${money(entry.total ?? 0)}` : '—'],
      ['Text', entry.text],
    ]) {
      facts.append(el('dt', '', label), el('dd', '', value));
    }
    const ignore = async () => {
      await post(`log/${entry.id}`, { action: 'ignore' });
      ops.edit('settings.manage', 'payment.qris-ignore', `QRIS notification set aside: "${entry.text.slice(0, 80)}".`, () => {});
    };
    if (entry.status !== 'unmatched') {
      const close = actionButton('Done', 'btn btn-primary');
      close.dataset.close = '';
      openDialog({ title: 'QRIS notification', body: [facts], footer: [close] });
      return;
    }
    if (desk.waiting.length === 0) {
      const dialog = openDialog({
        title: 'Unmatched notification',
        description: 'No QR is waiting, so there is nothing to place this on. If the customer’s QR ran out, find it under Payments and use Mark paid. Set this aside once it is dealt with.',
        body: [facts],
        footer: [
          act('Set aside', 'btn btn-outline', async () => {
            await ignore();
            dialog.close();
          }),
        ],
      });
      return;
    }
    formDialog({
      title: 'Unmatched notification',
      description: `"${entry.text}" named no waiting QR. Pick the QR this customer was paying, for example when they typed a different amount, and its booth or till finishes the order.`,
      submitLabel: 'Mark that QR paid',
      fields: [{ name: 'key', label: 'Waiting QR', value: desk.waiting[0].key, options: desk.waiting.map((qr) => ({ value: qr.key, label: `${reference(qr.key)} · ${money(qr.total)}` })) }],
      danger: {
        label: 'Set aside',
        run: (close) =>
          void ignore().then(close, (error: Error) => notice(error.message, 'error')),
      },
      async submit(values) {
        const key = String(values.key);
        await post(`log/${entry.id}`, { action: 'match', key });
        ops.edit('settings.manage', 'payment.qris-match', `QRIS ${reference(key)} settled by hand from the notification "${entry.text.slice(0, 80)}".`, () => {});
      },
    });
  }

  function waitingQrs(desk: QrisDeskState): HTMLElement {
    const part = section('QRs waiting now', 'Across every booth, kiosk and till. Each holds its total until it is paid, cancelled or out of time, so no other customer is asked for the same amount.');
    part.body.append(
      table<WaitingQr>(
        [
          { label: 'Reference', cell: (qr) => reference(qr.key) },
          { label: 'Customer pays', cell: (qr) => money(qr.total) },
          { label: 'Unique code', cell: (qr) => (qr.code ? money(qr.code) : '—') },
          { label: 'Valid until', cell: (qr) => new Date(qr.expiresAt).toLocaleTimeString(undefined, { timeStyle: 'short' }) },
          {
            label: '',
            cell: (qr) =>
              act('Release', 'btn btn-ghost btn-sm', async () => {
                const reply = await fetch(`/api/qris/charges/${encodeURIComponent(qr.key)}`, { method: 'DELETE' });
                if (!reply.ok) throw new Error('The booth computer refused that.');
                ops.edit('settings.manage', 'payment.qris-release', `Waiting QRIS ${reference(qr.key)} released: a payment to it will no longer settle on its own.`, () => {});
              }),
          },
        ],
        desk.waiting,
        { empty: 'No QR is waiting.' },
      ),
    );
    return part.root;
  }
}

/** A new POST address for the forwarding phone; the old one stops working. */
export async function renewQrisToken(): Promise<void> {
  await post('token');
}
