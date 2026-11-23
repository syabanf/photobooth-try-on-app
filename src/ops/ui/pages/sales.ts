// Transactions: every order with its payments and refunds, every booth session, and the activity
// log of every rupiah, refund, voucher and shift.

import { formDialog, openDialog } from '../../../dialogs';
import { getShots } from '../../../gallery';
import { seesBranch } from '../../access';
import { lineGross, lineNet, paidAmount } from '../../cart';
import { publishGallery } from '../../delivery';
import { PAYMENT_LABELS, SESSION_MODES, type BoothSession, type Order } from '../../model';
import type { Ops } from '../../ops';
import { shiftSlip } from '../../shift';
import type { PageContext } from '../router';
import { act, actionButton, badge, dateTime, el, money, page, pills, qrCanvas, table } from '../kit';
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

  const root = page('Transaksi', 'Penjualan, sesi, refund, shift dan log aktivitas. Staf hanya melihat cabang tempat mereka bekerja.');
  const filters = el('div', 'ops-filters');
  const branch = el('select', 'input select');
  branch.add(new Option('Semua cabang', ''));
  for (const location of ops.visibleBranches()) branch.add(new Option(location.name, location.id, false, location.id === view.branchId));
  branch.addEventListener('change', () => {
    view.branchId = branch.value;
    redraw();
  });
  const search = el('input', 'input');
  search.type = 'search';
  search.placeholder = 'Cari nomor, item, kode, alasan';
  search.value = view.search;
  search.addEventListener('change', () => {
    view.search = search.value;
    redraw();
  });
  filters.append(
    pills(
      [
        { value: 'orders', label: 'Pesanan' },
        { value: 'sessions', label: 'Sesi' },
        { value: 'refunds', label: 'Refund' },
        { value: 'shifts', label: 'Shift' },
        { value: 'activity', label: 'Log aktivitas' },
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
          { label: 'Pesanan', cell: (order) => order.number },
          { label: 'Waktu', cell: (order) => dateTime(order.paidAt ?? order.createdAt) },
          { label: 'Tempat', cell: (order) => (order.channel === 'booth' ? ops.boothName(order.boothId) : `Kasir · ${ops.branchName(order.branchId)}`) },
          { label: 'Item', cell: (order) => order.lines.map((line) => `${line.qty}× ${line.label}`).join(', ') },
          { label: 'Dibayar dengan', cell: (order) => order.payments.filter((p) => p.status === 'paid').map((p) => PAYMENT_LABELS[p.method]).join(' + ') || '—' },
          { label: 'Total', className: 'num', cell: (order) => money(order.total) },
          { label: 'Status', cell: (order) => statusBadge(order) },
        ],
        orders.slice(0, 300),
        { empty: 'Belum ada pesanan.', onRow: (order) => orderDialog(ops, order.id) },
      ),
    );
  } else if (view.tab === 'sessions') {
    const sessions = state.sessions.filter((session) => inScope(session.branchId) && matches(ops.boothName(session.boothId), session.voucherCode ?? '', session.mode));
    root.body.append(
      table(
        [
          { label: 'Mulai', cell: (session) => dateTime(session.startedAt) },
          { label: 'Booth', cell: (session) => ops.boothName(session.boothId) },
          { label: 'Mode', cell: (session) => SESSION_MODES[session.mode].label },
          { label: 'Bingkai', cell: (session) => state.frames.find((frame) => frame.id === session.frameId)?.name ?? '—' },
          { label: 'Dibayar dengan', cell: (session) => session.voucherCode ?? (session.orderId ? state.orders.find((o) => o.id === session.orderId)?.number ?? '—' : session.price === 0 ? 'Acara gratis' : '—') },
          { label: 'Harga', className: 'num', cell: (session) => money(session.price) },
          { label: 'File', className: 'num', cell: (session) => (session.purgedAt ? badge('Sudah dihapus', 'muted') : String(session.shotIds.length)) },
          { label: 'Tautan ponsel', cell: (session) => badge(session.deliveryUrl ? 'Siap' : session.endedAt && session.shotIds.length && !session.purgedAt ? 'Perlu dicoba lagi' : '—', session.deliveryUrl ? 'ok' : 'muted') },
          { label: 'Cetakan', className: 'num', cell: (session) => String(session.prints) },
          { label: 'Berbagi', cell: (session) => badge(session.consent ? 'Diizinkan' : 'Privat', session.consent ? 'ok' : 'muted') },
        ],
        sessions.slice(0, 300),
        { empty: 'Belum ada sesi booth.', onRow: (session) => sessionDialog(ops, session.id, redraw) },
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
          { label: 'Waktu', cell: (refund) => dateTime(refund.at) },
          { label: 'Pesanan', cell: (refund) => state.orders.find((order) => order.id === refund.orderId)?.number ?? '—' },
          { label: 'Item', cell: (refund) => state.orders.find((order) => order.id === refund.orderId)?.lines.find((line) => line.id === refund.lineId)?.label ?? '—' },
          { label: 'Alasan', cell: (refund) => refund.reason },
          { label: 'Oleh', cell: (refund) => state.staff.find((person) => person.id === refund.staffId)?.name ?? '—' },
          { label: 'Disetujui oleh', cell: (refund) => state.staff.find((person) => person.id === refund.supervisorId)?.name ?? '—' },
          { label: 'Dikembalikan lewat', cell: (refund) => PAYMENT_LABELS[refund.method] },
          { label: 'Jumlah', className: 'num', cell: (refund) => `−${money(refund.amount)}` },
        ],
        refunds,
        { empty: 'Belum ada refund.' },
      ),
    );
  } else if (view.tab === 'shifts') {
    const shifts = state.shifts.filter((shift) => inScope(shift.branchId));
    root.body.append(
      table(
        [
          { label: 'Cabang', cell: (shift) => ops.branchName(shift.branchId) },
          { label: 'Dibuka', cell: (shift) => dateTime(shift.openedAt) },
          { label: 'Ditutup', cell: (shift) => (shift.closedAt ? dateTime(shift.closedAt) : badge('Buka', 'ok')) },
          { label: 'Oleh', cell: (shift) => state.staff.find((person) => person.id === shift.staffId)?.name ?? '—' },
          { label: 'Bersih', className: 'num', cell: (shift) => money(shiftSlip(shift, state.orders, state.refunds).net) },
          {
            label: 'Laci',
            className: 'num',
            cell: (shift) => {
              const variance = shiftSlip(shift, state.orders, state.refunds).variance;
              return variance === null ? '—' : badge(variance === 0 ? 'Cocok' : `${variance > 0 ? '+' : ''}${money(variance)}`, variance === 0 ? 'ok' : 'warn');
            },
          },
        ],
        shifts,
        { empty: 'Belum ada shift.', onRow: (shift) => showSlip(ops, shiftSlip(shift, state.orders, state.refunds), shift.id) },
      ),
    );
  } else {
    const entries = state.activity.filter((entry) => (!entry.branchId || inScope(entry.branchId)) && matches(entry.message, entry.kind));
    root.body.append(
      table(
        [
          { label: 'Waktu', cell: (entry) => dateTime(entry.at) },
          { label: 'Siapa', cell: (entry) => state.staff.find((person) => person.id === entry.staffId)?.name ?? 'Sistem' },
          { label: 'Apa', cell: (entry) => entry.message },
          { label: 'Jumlah', className: 'num', cell: (entry) => (entry.amount === undefined ? '' : money(entry.amount)) },
        ],
        entries.slice(0, 500),
        { empty: 'Belum ada catatan.' },
      ),
    );
  }
  return root.root;
}

function statusBadge(order: Order): HTMLElement {
  if (order.status === 'void') return badge('Batal', 'muted');
  if (order.status === 'open') return badge('Menunggu pembayaran', 'warn');
  const refunded = order.lines.filter((line) => line.refunded).length;
  if (refunded === order.lines.length) return badge('Sudah refund', 'error');
  if (refunded) return badge('Refund sebagian', 'warn');
  return badge('Lunas', 'ok');
}

/** One order: lines with per-item refund, payments, codes, receipt. */
function orderDialog(ops: Ops, orderId: string): void {
  const order = ops.order(orderId);
  const lines = el('div', 'cart-lines');
  for (const line of order.lines) {
    const row = el('div', 'cart-line');
    const text = el('div', 'cart-text');
    text.append(el('span', 'rank-name', `${line.qty}× ${line.label}`), el('span', 'rank-meta', line.discount ? `${money(lineGross(line))} − diskon ${money(line.discount)}` : money(lineGross(line))));
    row.append(text);
    if (line.refunded) row.append(badge('Sudah refund', 'error'));
    else if (order.status === 'paid' && ops.can('pos.sell')) {
      const refund = actionButton(`Refund ${money(lineNet(line))}`, 'btn btn-ghost btn-sm btn-danger');
      refund.addEventListener('click', () => {
        dialog.close();
        formDialog({
          title: `Refund ${line.label}`,
          description: `${money(lineNet(line))} dikembalikan ke pelanggan. Supervisor mengetik PIN untuk menyetujui.`,
          submitLabel: 'Refund',
          fields: [
            { name: 'reason', label: 'Alasan', value: '', placeholder: 'Contoh: Cetakan terlalu gelap' },
            { name: 'pin', label: 'PIN supervisor', value: '', type: 'password' },
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
    ['Waktu', dateTime(order.paidAt ?? order.createdAt)],
    ['Tempat', order.channel === 'booth' ? ops.boothName(order.boothId) : `Kasir · ${ops.branchName(order.branchId)}`],
    ['Kasir', ops.state.staff.find((person) => person.id === order.staffId)?.name ?? '—'],
    ['Subtotal', money(order.subtotal)],
    ['Diskon', order.discount ? `−${money(order.discount)}${order.voucherCode ? ` (${order.voucherCode})` : ''}` : '—'],
    ['Total', money(order.total)],
    ['Lunas', `${money(paidAmount(order.payments))} dengan ${order.payments.filter((p) => p.status === 'paid').map((p) => `${PAYMENT_LABELS[p.method]}${p.reference ? ` ${p.reference}` : ''}`).join(', ') || '—'}`],
    ['Antrean', order.ticketNumbers.join(', ') || '—'],
    ['Kode sesi', order.sessionVouchers.join(', ') || '—'],
  ];
  for (const [label, value] of rows) facts.append(el('dt', '', label), el('dd', '', value));
  const print = act('Cetak struk', 'btn btn-outline', () => printReceipt(ops, order), 'printer');
  const close = actionButton('Selesai', 'btn btn-primary');
  close.dataset.close = '';
  const dialog = openDialog({ title: order.number, body: [lines, facts], footer: [print, close] });
}

function sessionDialog(ops: Ops, sessionId: string, redraw: () => void): void {
  const session: BoothSession | undefined = ops.state.sessions.find((entry) => entry.id === sessionId);
  if (!session) return;
  const details = el('div', 'panel-stack');
  details.append(el('p', 'card-desc', `${SESSION_MODES[session.mode].label} · ${dateTime(session.startedAt)} · ${ops.boothName(session.boothId)}`));
  const status = el('p', 'field-hint');
  status.setAttribute('role', 'status');
  details.append(status);
  const close = actionButton('Selesai', 'btn btn-primary');
  close.dataset.close = '';
  let retry: HTMLButtonElement | null = null;
  if (session.deliveryUrl) {
    status.textContent = 'Hubungkan ponsel pelanggan ke Wi-Fi lokasi sebelum memindai.';
    details.append(qrCanvas(session.deliveryUrl, 200));
  } else if (session.endedAt && session.shotIds.length && !session.purgedAt && !session.failureReason) {
    status.textContent = 'File masih ada di booth ini. Coba unggah lagi untuk memulihkan QR ponsel.';
    retry = act('Pulihkan tautan ponsel', 'btn btn-outline', async () => {
      retry!.disabled = true;
      status.textContent = 'Memeriksa file tersimpan dan mengunggah…';
      try {
        const shots = await getShots(session.shotIds);
        if (shots.length !== session.shotIds.length) throw new Error('Sebagian file tersimpan tidak ada di perangkat ini.');
        const files = shots.filter((shot) => shot.kind !== 'bts').map(({ id, kind, blob }) => ({ id, kind, blob }));
        if (!files.length) throw new Error('Tidak ada file pelanggan yang tersedia.');
        const url = await publishGallery(session.token, ops.state.branding.brandName || ops.account.business, files, ops.state.settings.retentionDays);
        if (!url) throw new Error('Server foto tidak tersedia. Periksa jaringan booth lalu coba lagi.');
        ops.setSessionDelivery(session.id, url);
        status.textContent = 'Tautan ponsel dipulihkan. Pindai QR dengan ponsel yang terhubung ke Wi-Fi lokasi.';
        details.append(qrCanvas(url, 200));
        retry!.remove();
        redraw();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Tautan ponsel gagal dipulihkan.';
        retry!.disabled = false;
      }
    });
  } else status.textContent = session.purgedAt ? 'File tersimpan sudah kedaluwarsa.' : session.failureReason ? 'Pengambilan foto gagal di sesi ini.' : 'Tidak ada file selesai yang tersedia.';
  openDialog({ title: 'Sesi booth', body: [details], footer: retry ? [retry, close] : [close] });
}
