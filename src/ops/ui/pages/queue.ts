// The queue desk: issue tickets, call the next customer per booth, re-call, mark served or
// no-show, put a late customer back, and drag to reorder. The TV display follows every change.

import { formDialog, openDialog } from '../../../dialogs';
import { iconButton } from '../../../icons';
import type { Ticket } from '../../model';
import { queueFor } from '../../queue';
import type { PageContext } from '../router';
import { act, actionButton, badge, count, el, notice, page, qrCanvas, section } from '../kit';

export function renderQueue({ ops }: PageContext): HTMLElement {
  const { tickets } = ops.state;
  const booths = ops.visibleBooths().filter((point) => point.active);
  const view = page('Antrean', 'Satu tiket bisa menunggu di beberapa booth. Booth pertama yang kosong memanggilnya, lalu tiket keluar dari antrean lain.');
  view.actions.append(
    act('Buat tiket', 'btn btn-primary', () => issueDialog(ops, booths.map((b) => ({ id: b.id, name: b.name }))), 'ticket'),
    act('Layar TV', 'btn btn-outline', () => window.open(`${location.pathname}#display=queue&lock=1`, 'vto-queue-tv', 'popup,width=1280,height=720'), 'tv'),
    act('Kiosk swalayan', 'btn btn-outline', () => openKiosk(ops), 'ticket'),
  );

  if (booths.length === 0) {
    view.body.append(el('p', 'card-desc', 'Tambah booth aktif di halaman Lokasi untuk menjalankan antrean.'));
    return view.root;
  }

  // ---------- booths ----------
  const desk = el('div', 'queue-desk');
  for (const booth of booths) {
    const card = el('section', 'queue-booth');
    const now = tickets.find((ticket) => ticket.status === 'called' && ticket.calledBoothId === booth.id);
    const waiting = queueFor(tickets, booth.id);
    card.append(el('p', 'kicker', booth.name), el('p', 'queue-now', now ? now.number : '—'), el('p', 'card-desc', `${waiting.filter((t) => t.checkedIn).length} menunggu · ${waiting.filter((t) => !t.checkedIn).length} belum check-in`));
    const actions = el('div', 'queue-actions');
    if (now) {
      actions.append(
        act('Panggil ulang', 'btn btn-outline btn-sm', () => ops.recall(now.id), 'megaphone'),
        act('Sudah dilayani', 'btn btn-secondary btn-sm', () => ops.completeTicket(now.id), 'check'),
        act('Tidak datang', 'btn btn-ghost btn-sm', () => ops.skipTicket(now.id)),
      );
    }
    actions.append(
      act('Panggil berikutnya', 'btn btn-primary btn-sm', () => {
        const called = ops.callNext(booth.id);
        notice(called ? `${called.number} ke ${booth.name}.` : 'Tidak ada pelanggan yang sudah check-in menunggu booth ini.', called ? 'ok' : 'warn');
      }),
    );
    card.append(actions);
    desk.append(card);
  }

  // ---------- waiting line, drag to reorder ----------
  const line = section('Menunggu', 'Seret tiket untuk memindahkannya. Tiket yang belum check-in tetap di tempatnya tapi dilewati sampai check-in.');
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
    grip.append(iconButton('grip', 'Seret untuk mengubah urutan'));
    const text = el('div', 'rank-text');
    text.append(el('span', 'queue-number', ticket.number), el('span', 'rank-meta', [ticket.name, ticket.boothIds.map((id) => ops.boothName(id)).join(' / ')].filter(Boolean).join(' · ')));
    const up = iconButton('arrowUp', `Naikkan ${ticket.number}`);
    up.addEventListener('click', () => {
      const index = waiting.indexOf(ticket);
      if (index > 0) ops.moveTicket(ticket.id, waiting[index - 1].id);
    });
    const show = iconButton('qr', `Tampilkan ${ticket.number}`);
    show.addEventListener('click', () => ticketDialog(ticket));
    const faces = ops.facesForTicket(ticket.id).length;
    item.append(grip, text, ticket.checkedIn ? badge('Sudah check-in', 'ok') : badge('Belum datang', 'warn'), ...(faces ? [badge(count(faces, 'wajah'), 'info')] : []), up, show);
    list.append(item);
  }
  list.addEventListener('dragover', (event) => event.preventDefault());
  list.addEventListener('drop', (event) => {
    if ((event.target as Element) === list && dragged) ops.moveTicket(dragged, null);
  });
  if (waiting.length === 0) list.append(el('li', 'card-desc', 'Tidak ada yang menunggu.'));
  line.body.append(list);

  // ---------- skipped: re-register ----------
  const late = section('Terlewat panggilan', 'Masukkan lagi pelanggan yang terlambat, di depan atau di belakang antrean.');
  const skipped = tickets.filter((ticket) => ticket.status === 'skipped').slice(-10).reverse();
  const lateList = el('div', 'queue-late');
  for (const ticket of skipped) {
    const row = el('div', 'cart-line');
    row.append(el('span', 'queue-number', ticket.number), el('span', 'rank-meta', ticket.name || ''), act('Depan', 'btn btn-outline btn-sm', () => ops.reRegister(ticket.id, 'front')), act('Belakang', 'btn btn-ghost btn-sm', () => ops.reRegister(ticket.id, 'back')));
    lateList.append(row);
  }
  if (skipped.length === 0) lateList.append(el('p', 'card-desc', 'Tidak ada tiket yang terlewat.'));
  late.body.append(lateList);

  view.body.append(desk, line.root, late.root);
  return view.root;
}

function issueDialog(ops: PageContext['ops'], booths: { id: string; name: string }[]): void {
  formDialog({
    title: 'Buat tiket',
    description: 'Centang setiap booth yang mau dipakai pelanggan. Nomor WhatsApp atau email menerima pesan saat dipanggil.',
    submitLabel: 'Buat',
    fields: [
      { name: 'boothIds', label: 'Booths', value: booths.map((booth) => booth.id), options: booths.map((booth) => ({ value: booth.id, label: booth.name })) },
      { name: 'name', label: 'Nama', value: '', placeholder: 'Opsional' },
      { name: 'phone', label: 'WhatsApp', value: '', type: 'tel', placeholder: '+62…' },
      { name: 'email', label: 'Email', value: '', type: 'email' },
      { name: 'checkedIn', label: 'Pelanggan sudah di sini', value: true, hint: 'Matikan untuk booking: pelanggan check-in dengan memindai QR tiket saat datang.' },
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
  body.append(el('p', 'display-queue', ticket.number), qrCanvas(link, 200), el('p', 'card-desc', ticket.checkedIn ? 'Pindai untuk melihat posisi Anda di antrean.' : 'Pindai saat tiba untuk check-in.'));
  const open = actionButton('Buka halaman check-in', 'btn btn-outline');
  open.addEventListener('click', () => window.open(link, '_blank'));
  const done = actionButton('Selesai', 'btn btn-primary');
  done.dataset.close = '';
  openDialog({ title: `Tiket ${ticket.number}`, body: [body], footer: [open, done] });
}

/**
 * Opens the kiosk in its own tab for one booth. The tab inherits this tab's Decart key, so the
 * kiosk can make AI prints; without one it prints the filled template.
 */
function openKiosk(ops: PageContext['ops']): void {
  const open = (boothId: string) => {
    window.open(`${location.pathname}#display=kiosk&booth=${encodeURIComponent(boothId)}&lock=1`, 'vto-kiosk');
    ops.edit('queue.run', 'display.kiosk', `Membuka kiosk untuk ${ops.boothName(boothId)}.`, () => {});
  };
  const booths = ops.visibleBooths().filter((point) => point.active);
  const here = ops.hooks.devicePointId();
  if (here && booths.some((booth) => booth.id === here)) return void open(here);
  if (booths.length === 1) return void open(booths[0].id);
  formDialog({
    title: 'Kiosk swalayan',
    description: 'Kiosk menjual cetakan preset AI untuk booth ini dan mengirimnya ke printer booth.',
    submitLabel: 'Buka kiosk',
    fields: [{ name: 'booth', label: 'Booth', value: booths[0]?.id ?? '', options: booths.map((booth) => ({ value: booth.id, label: booth.name })) }],
    async submit(values) {
      open(String(values.booth));
    },
  });
}
