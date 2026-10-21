// Payments: every customer payment with its status and actions, and the rules behind them: which
// methods the till and the booth take, the fee each one costs, the QRIS gateway, EDC terminals and
// e-wallets.

import { formDialog, openDialog } from '../../../dialogs';
import { seesBranch } from '../../access';
import { PAYMENT_LABELS, PAYMENT_METHODS, PAYMENT_STATUS_LABELS, type Channel, type PaymentMethod, type PaymentStatus, type Terminal } from '../../model';
import type { Ops } from '../../ops';
import { GATEWAY_NAMES, allowedMethods, gatewayLabel, paymentRows, summarizePayments, type PaymentRow } from '../../payments';
import { toCsv } from '../../reports';
import { qrisPayload } from '../../encoders';
import type { PageContext } from '../router';
import { act, actionButton, badge, dateTime, downloadText, el, money, notice, page, pills, qrCanvas, section, statRow, table, type BadgeKind } from '../kit';

type Tab = 'list' | 'methods' | 'gateway' | 'terminals';
const STATUSES: PaymentStatus[] = ['pending', 'paid', 'expired', 'failed', 'cancelled'];
const STATUS_KIND: Record<PaymentStatus, BadgeKind> = { pending: 'warn', paid: 'ok', expired: 'muted', failed: 'error', cancelled: 'muted' };

const view = { tab: 'list' as Tab, status: '' as PaymentStatus | '', method: '' as PaymentMethod | '', channel: '' as Channel | '', branchId: '', query: '' };

export function renderPayments(context: PageContext): HTMLElement {
  const { ops, redraw } = context;
  ops.expirePayments();
  const root = page('Payments', 'Every customer payment, and the methods, fees and gateway behind them.');
  const manages = ops.can('settings.manage');
  const tabs: { value: Tab; label: string }[] = [{ value: 'list', label: 'Payments' }];
  if (manages) tabs.push({ value: 'methods', label: 'Methods and fees' }, { value: 'gateway', label: 'QRIS gateway' }, { value: 'terminals', label: 'Terminals and e-wallets' });
  if (!tabs.some((tab) => tab.value === view.tab)) view.tab = 'list';
  if (tabs.length > 1) {
    root.body.append(
      pills(tabs, view.tab, (tab) => {
        view.tab = tab;
        redraw();
      }),
    );
  }
  const draw = { list: paymentList, methods: methodsTab, gateway: gatewayTab, terminals: terminalsTab }[view.tab];
  root.body.append(draw(context));
  return root.root;
}

// ---------- the list ----------

function paymentList({ ops, redraw, nav }: PageContext): HTMLElement {
  const { state } = ops;
  const actor = ops.actor();
  const orders = state.orders.filter((order) => seesBranch(actor, order.branchId));
  const rows = paymentRows(orders, { status: view.status, method: view.method, channel: view.channel, branchId: view.branchId, query: view.query });
  const summary = summarizePayments(rows, state.refunds);
  const box = el('div', 'ops-section-body');

  const filters = el('div', 'ops-filters');
  const select = <T extends string>(label: string, options: { value: T; label: string }[], current: T, onPick: (value: T) => void) => {
    const input = el('select', 'input select');
    input.add(new Option(label, ''));
    for (const option of options) input.add(new Option(option.label, option.value, false, option.value === current));
    input.addEventListener('change', () => {
      onPick(input.value as T);
      redraw();
    });
    return input;
  };
  const search = el('input', 'input');
  search.type = 'search';
  search.placeholder = 'Order, reference, wallet';
  search.value = view.query;
  search.addEventListener('change', () => {
    view.query = search.value;
    redraw();
  });
  filters.append(
    select('Any status', STATUSES.map((status) => ({ value: status, label: PAYMENT_STATUS_LABELS[status] })), view.status, (value) => (view.status = value)),
    select('Any method', PAYMENT_METHODS.map((method) => ({ value: method, label: PAYMENT_LABELS[method] })), view.method, (value) => (view.method = value)),
    select('Till and booth', [{ value: 'cashier' as Channel, label: 'Till' }, { value: 'booth' as Channel, label: 'Booth' }], view.channel, (value) => (view.channel = value)),
    select('All branches', ops.visibleBranches().map((branch) => ({ value: branch.id, label: branch.name })), view.branchId, (value) => (view.branchId = value)),
    search,
    act('CSV', 'btn btn-outline btn-sm', () =>
      downloadText(
        toCsv(
          ['When', 'Order', 'Channel', 'Branch', 'Method', 'Via', 'Reference', 'Amount', 'Fee', 'Status', 'Note'],
          rows.map(({ payment, order }) => [
            new Date(payment.paidAt ?? payment.createdAt).toISOString(),
            order.number,
            order.channel === 'booth' ? ops.boothName(order.boothId) : 'Till',
            ops.branchName(order.branchId),
            PAYMENT_LABELS[payment.method],
            via(ops, payment),
            payment.reference,
            payment.amount,
            payment.fee ?? 0,
            PAYMENT_STATUS_LABELS[payment.status],
            payment.note ?? '',
          ]),
        ),
        'payments.csv',
      ),
    'download'),
  );

  box.append(
    filters,
    statRow([
      { label: 'Paid', value: money(summary.paid), hint: `${rows.filter((row) => row.payment.status === 'paid').length} payments` },
      { label: 'Fees', value: money(summary.fees), hint: 'At the rates on Methods and fees' },
      { label: 'Net', value: money(summary.net), hint: summary.refunded ? `${money(summary.refunded)} refunded` : 'After fees and refunds' },
      { label: 'Waiting', value: String(summary.pending), hint: summary.pending ? `${money(summary.pendingAmount)} in open QRs` : 'No open QRs' },
    ]),
    table(
      [
        { label: 'When', cell: ({ payment }) => dateTime(payment.paidAt ?? payment.createdAt) },
        { label: 'Order', cell: ({ order }) => order.number },
        { label: 'Where', cell: ({ order }) => (order.channel === 'booth' ? ops.boothName(order.boothId) : `Till · ${ops.branchName(order.branchId)}`) },
        { label: 'Method', cell: ({ payment }) => [PAYMENT_LABELS[payment.method], via(ops, payment)].filter(Boolean).join(' · ') },
        { label: 'Reference', cell: ({ payment }) => (payment.reference ? el('span', 'code', payment.reference) : '—') },
        { label: 'Amount', className: 'num', cell: ({ payment }) => money(payment.amount) },
        { label: 'Fee', className: 'num', cell: ({ payment }) => (payment.fee ? money(payment.fee) : '—') },
        { label: 'Status', cell: ({ payment }) => badge(PAYMENT_STATUS_LABELS[payment.status], STATUS_KIND[payment.status]) },
      ],
      rows.slice(0, 400),
      { empty: 'No payments match.', onRow: (row) => paymentDialog(ops, row, nav) },
    ),
  );
  return box;
}

function via(ops: Ops, payment: { wallet?: string; terminalId?: string; gateway?: string }): string {
  if (payment.wallet) return payment.wallet;
  if (payment.terminalId) return ops.payments.terminals.find((terminal) => terminal.id === payment.terminalId)?.name ?? 'Terminal';
  return payment.gateway ?? '';
}

/** One payment: its details, the QR while it waits, and the actions a pending QR allows. */
function paymentDialog(ops: Ops, { payment, order }: PaymentRow, nav: PageContext['nav']): void {
  const facts = el('dl', 'facts');
  const rows: [string, string][] = [
    ['Order', order.number],
    ['Where', order.channel === 'booth' ? ops.boothName(order.boothId) : `Till · ${ops.branchName(order.branchId)}`],
    ['Method', [PAYMENT_LABELS[payment.method], via(ops, payment)].filter(Boolean).join(' · ')],
    ['Amount', money(payment.amount)],
    ['Fee', payment.fee ? money(payment.fee) : '—'],
    ['Reference', payment.reference || '—'],
    ['Created', dateTime(payment.createdAt)],
    ['Paid', dateTime(payment.paidAt)],
    ['Expires', payment.expiresAt ? dateTime(payment.expiresAt) : '—'],
    ['Note', payment.note ?? '—'],
  ];
  if (payment.tendered) rows.splice(4, 0, ['Cash received', `${money(payment.tendered)} · change ${money(payment.tendered - payment.amount)}`]);
  for (const [label, value] of rows) facts.append(el('dt', '', label), el('dd', '', value));
  const body: Node[] = [facts];
  if (payment.status === 'pending' && payment.qrString) body.unshift(qrCanvas(payment.qrString, 200));

  const footer: Node[] = [];
  if (payment.status === 'pending') {
    footer.push(
      act('Cancel QR', 'btn btn-ghost btn-danger', () => {
        dialog.close();
        formDialog({
          title: 'Cancel this QR',
          description: 'The customer can pay another way or get a new QR. The order stays open.',
          submitLabel: 'Cancel QR',
          fields: [{ name: 'reason', label: 'Reason', value: '', placeholder: 'Customer left' }],
          async submit(values) {
            ops.cancelPayment(order.id, payment.id, String(values.reason));
          },
        });
      }),
      act('Mark paid', 'btn btn-outline', () => {
        dialog.close();
        formDialog({
          title: 'Mark as paid',
          description: 'For a payment the bank app shows as done but the gateway never reported. A supervisor approves it with their PIN, and the log keeps the reference.',
          submitLabel: 'Mark paid',
          fields: [
            { name: 'reference', label: 'Bank or wallet reference', value: '', placeholder: 'BCA 7781 · 14:02' },
            { name: 'pin', label: 'Supervisor PIN', value: '', type: 'password' },
          ],
          async submit(values) {
            await ops.confirmPayment(order.id, payment.id, String(values.reference), String(values.pin));
            notice(`${order.number} marked paid.`, 'ok');
          },
        });
      }),
    );
  }
  const open = actionButton('Open order', 'btn btn-outline');
  open.addEventListener('click', () => {
    dialog.close();
    nav('sales');
  });
  const close = actionButton('Done', 'btn btn-primary');
  close.dataset.close = '';
  footer.push(open, close);
  const dialog = openDialog({ title: `${PAYMENT_LABELS[payment.method]} · ${money(payment.amount)}`, description: `${PAYMENT_STATUS_LABELS[payment.status]} · ${order.number}`, body, footer });
}

// ---------- methods and fees ----------

function methodsTab({ ops }: PageContext): HTMLElement {
  const { methods } = ops.payments;
  const part = section('Methods and fees', 'Where each method is offered, and the processing fee it costs. Fees are recorded on each payment at the rate of the day and shown net on reports.');
  const toggle = (method: PaymentMethod, key: 'enabled' | 'cashier' | 'booth') => {
    const on = methods[method][key];
    return act(on ? 'On' : 'Off', on ? 'btn btn-secondary btn-sm' : 'btn btn-ghost btn-sm', () =>
      ops.savePaymentSettings((draft) => (draft.methods[method][key] = !on), `${PAYMENT_LABELS[method]}: ${key === 'enabled' ? 'switched' : key === 'cashier' ? 'at the till' : 'at the booth'} ${on ? 'off' : 'on'}.`),
    );
  };
  part.body.append(
    table(
      [
        { label: 'Method', cell: (method: PaymentMethod) => PAYMENT_LABELS[method] },
        { label: 'Enabled', cell: (method) => toggle(method, 'enabled') },
        { label: 'At the till', cell: (method) => toggle(method, 'cashier') },
        { label: 'At the booth', cell: (method) => toggle(method, 'booth') },
        { label: 'Fee', className: 'num', cell: (method) => `${methods[method].feePercent}%` },
        {
          label: '',
          className: 'actions',
          cell: (method) =>
            act('Fee', 'btn btn-ghost btn-sm', () =>
              formDialog({
                title: `${PAYMENT_LABELS[method]} fee`,
                submitLabel: 'Save',
                fields: [{ name: 'fee', label: 'Processing fee (%)', value: String(methods[method].feePercent), type: 'number', hint: 'QRIS MDR is 0.7% for most merchants; cards and e-wallets run 1.5% to 2%.' }],
                async submit(values) {
                  const fee = Number(values.fee);
                  if (!(fee >= 0 && fee <= 10)) throw new Error('Enter a fee between 0 and 10 percent.');
                  ops.savePaymentSettings((draft) => (draft.methods[method].feePercent = fee), `${PAYMENT_LABELS[method]} fee set to ${fee}%.`);
                },
              }),
            ),
        },
      ],
      PAYMENT_METHODS,
    ),
    el('p', 'field-hint', `The till takes ${allowedMethods(ops.payments, 'cashier').map((m) => PAYMENT_LABELS[m]).join(', ') || 'nothing'}; the booth takes ${allowedMethods(ops.payments, 'booth').map((m) => PAYMENT_LABELS[m]).join(', ') || 'nothing'}.`),
  );
  return part.root;
}

// ---------- gateway ----------

function gatewayTab({ ops }: PageContext): HTMLElement {
  const { gateway } = ops.payments;
  const part = section('QRIS gateway', 'The provider that issues dynamic QRs and reports payments back. The app only ever holds the client key; the server key stays on your server.');
  part.actions.append(
    act('Edit', 'btn btn-outline btn-sm', () =>
      formDialog({
        title: 'QRIS gateway',
        submitLabel: 'Save',
        fields: [
          { name: 'provider', label: 'Provider', value: gateway.provider, options: (Object.keys(GATEWAY_NAMES) as (keyof typeof GATEWAY_NAMES)[]).map((key) => ({ value: key, label: GATEWAY_NAMES[key] })) },
          { name: 'mode', label: 'Mode', value: gateway.mode, options: [{ value: 'sandbox', label: 'Sandbox (test money)' }, { value: 'production', label: 'Production (real money)' }] },
          { name: 'merchantId', label: 'Merchant ID', value: gateway.merchantId },
          { name: 'clientKey', label: 'Client key', value: gateway.clientKey, type: 'password', hint: 'The public, browser-safe key. Never paste the server key here.' },
          { name: 'qrExpiryMinutes', label: 'QR valid for (minutes)', value: String(gateway.qrExpiryMinutes), type: 'number' },
        ],
        async submit(values) {
          const minutes = Number(values.qrExpiryMinutes);
          if (!(minutes >= 1 && minutes <= 120)) throw new Error('Use 1 to 120 minutes.');
          const key = String(values.clientKey).trim();
          if (/server|secret/i.test(key) || /^SB-Mid-server|^Mid-server|^xnd_(development|production)_/.test(key)) throw new Error('That looks like a server key. Keep it on the server and paste the client key here.');
          ops.savePaymentSettings((draft) => {
            Object.assign(draft.gateway, { provider: values.provider as never, mode: values.mode as never, merchantId: String(values.merchantId).trim(), clientKey: key, qrExpiryMinutes: minutes });
          }, `Gateway set to ${GATEWAY_NAMES[values.provider as keyof typeof GATEWAY_NAMES]} ${values.mode}.`);
        },
      }),
    'edit'),
    act('Test QR', 'btn btn-ghost btn-sm', () => {
      const sample = qrisPayload({ merchantName: ops.state.branding.brandName || ops.account.business, merchantCity: ops.sites.locations[0]?.city || 'JAKARTA', merchantId: gateway.merchantId || 'TEST', amount: 1000, reference: 'TEST-QR' });
      const close = actionButton('Done', 'btn btn-primary');
      close.dataset.close = '';
      openDialog({ title: 'Test QR', description: `A Rp1.000 QR in ${gatewayLabel(ops.payments)}'s shape. In this build nothing can pay it; with the server integration a sandbox app can.`, body: [qrCanvas(sample, 220)], footer: [close] });
    }, 'qr'),
  );
  const facts = el('dl', 'facts');
  for (const [label, value] of [
    ['Provider', gatewayLabel(ops.payments)],
    ['Merchant ID', gateway.merchantId || 'Not set'],
    ['Client key', gateway.clientKey ? `${gateway.clientKey.slice(0, 6)}…` : 'Not set'],
    ['QR valid for', `${gateway.qrExpiryMinutes} minutes`],
    ['In this build', 'Simulated: the QR has the right shape, no money moves, and "Simulate payment" stands in for the callback.'],
  ]) {
    facts.append(el('dt', '', label), el('dd', '', value));
  }
  part.body.append(facts);
  if (gateway.mode === 'production') part.body.append(badge('Production mode: real charges once the server integration is live', 'warn'));
  return part.root;
}

// ---------- terminals and e-wallets ----------

function terminalsTab({ ops }: PageContext): HTMLElement {
  const box = el('div', 'ops-body');
  const terminals = section('EDC terminals', 'Card machines per branch. The till records which one took a card payment.');
  const editTerminal = (terminal?: Terminal) =>
    formDialog({
      title: terminal ? `Edit ${terminal.name}` : 'Add terminal',
      submitLabel: 'Save',
      fields: [
        { name: 'name', label: 'Name', value: terminal?.name ?? '', placeholder: 'EDC 1' },
        { name: 'branchId', label: 'Branch', value: terminal?.branchId ?? ops.visibleBranches()[0]?.id ?? '', options: ops.visibleBranches().map((branch) => ({ value: branch.id, label: branch.name })) },
        { name: 'provider', label: 'Bank or acquirer', value: terminal?.provider ?? '', placeholder: 'BCA' },
      ],
      danger: terminal ? { label: 'Delete', run: (close) => { ops.savePaymentSettings((draft) => { draft.terminals = draft.terminals.filter((entry) => entry.id !== terminal.id); }, `Removed terminal ${terminal.name}.`); close(); } } : undefined,
      async submit(values) {
        const name = String(values.name).trim();
        if (!name) throw new Error('Enter a name.');
        if (!values.branchId) throw new Error('Add a location first.');
        ops.savePaymentSettings((draft) => {
          const fields = { name, branchId: String(values.branchId), provider: String(values.provider).trim() };
          const existing = draft.terminals.find((entry) => entry.id === terminal?.id);
          if (existing) Object.assign(existing, fields);
          else draft.terminals.push({ id: ops.store.id(), ...fields });
        }, `Saved terminal ${name}.`);
      },
    });
  terminals.actions.append(act('Add terminal', 'btn btn-outline btn-sm', () => editTerminal(), 'plus'));
  terminals.body.append(
    table(
      [
        { label: 'Terminal', cell: (terminal: Terminal) => terminal.name },
        { label: 'Branch', cell: (terminal) => ops.branchName(terminal.branchId) },
        { label: 'Acquirer', cell: (terminal) => terminal.provider || '—' },
      ],
      ops.payments.terminals,
      { empty: 'No terminals. Card payments still record their approval code.', onRow: editTerminal },
    ),
  );

  const wallets = section('E-wallets', 'The brands the till can pick when a customer pays from a wallet app.');
  wallets.actions.append(
    act('Add e-wallet', 'btn btn-outline btn-sm', () =>
      formDialog({
        title: 'Add e-wallet',
        submitLabel: 'Add',
        fields: [{ name: 'name', label: 'Name', value: '', placeholder: 'LinkAja' }],
        async submit(values) {
          const name = String(values.name).trim();
          if (!name) throw new Error('Enter a name.');
          if (ops.payments.wallets.some((wallet) => wallet.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already listed.`);
          ops.savePaymentSettings((draft) => draft.wallets.push(name), `Added e-wallet ${name}.`);
        },
      }),
    'plus'),
  );
  const chips = el('div', 'check-group');
  for (const wallet of ops.payments.wallets) {
    const chip = el('span', 'check', wallet);
    const remove = actionButton('×', 'btn btn-ghost btn-sm');
    remove.setAttribute('aria-label', `Remove ${wallet}`);
    remove.addEventListener('click', () => ops.savePaymentSettings((draft) => { draft.wallets = draft.wallets.filter((entry) => entry !== wallet); }, `Removed e-wallet ${wallet}.`));
    chip.append(remove);
    chips.append(chip);
  }
  if (ops.payments.wallets.length === 0) chips.append(el('p', 'card-desc', 'No e-wallets listed; the till records the reference only.'));
  wallets.body.append(chips);
  box.append(terminals.root, wallets.root);
  return box;
}
