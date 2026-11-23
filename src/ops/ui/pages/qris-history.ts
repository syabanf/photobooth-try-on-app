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

const STATUS_LABELS: Record<Status, string> = { matched: 'Cocok', unmatched: 'Tidak cocok', ignored: 'Diabaikan' };
const STATUS_KIND: Record<Status, BadgeKind> = { matched: 'ok', unmatched: 'warn', ignored: 'muted' };
const view = { status: '' as Status | '', query: '' };

/** The payment reference inside a QR's key, without the device that showed it. */
const reference = (key: string) => key.slice(key.indexOf(':') + 1);

/** The booth computer's QRIS state, or the reason this device cannot see it. */
export async function loadQrisDesk(): Promise<QrisDeskState | string> {
  const reply = await fetch('/api/qris/setup').catch(() => null);
  if (!reply) return 'Komputer booth tidak menjawab. QRIS milik toko butuh aplikasi yang dibuka dari komputer booth (pnpm serve).';
  const data = (await reply.json().catch(() => ({}))) as QrisDeskState & { error?: string };
  return reply.ok ? data : (data.error ?? 'Buka halaman ini di komputer booth.');
}

async function post(path: string, body?: unknown): Promise<void> {
  const reply = await fetch(`/api/qris/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  if (!reply.ok) throw new Error(((await reply.json().catch(() => ({}))) as { error?: string }).error ?? 'Komputer booth menolak permintaan itu.');
}

export function qrisHistoryTab({ ops, redraw }: PageContext): HTMLElement {
  const box = el('div', 'ops-body');
  box.append(el('p', 'card-desc', 'Memeriksa komputer booth…'));
  void loadQrisDesk().then((desk) => {
    if (typeof desk === 'string') return box.replaceChildren(el('p', 'callout', desk));
    box.replaceChildren(history(desk), waitingQrs(desk));
  });
  return box;

  function history(desk: QrisDeskState): HTMLElement {
    const part = section('Notifikasi QRIS', 'Setiap notifikasi "dana masuk" yang diteruskan ponsel, terbaru di atas, beserta QR yang dilunasinya. Komputer booth menyimpan 500 terakhir.');
    const today = new Date().setHours(0, 0, 0, 0);
    const recent = desk.log.filter((entry) => entry.at >= today);
    const matched = recent.filter((entry) => entry.status === 'matched');
    const open = desk.log.filter((entry) => entry.status === 'unmatched');
    const query = view.query.trim().toLowerCase();
    const rows = desk.log.filter((entry) => (!view.status || entry.status === view.status) && (!query || `${entry.text} ${entry.key ?? ''} ${entry.amounts.join(' ')}`.toLowerCase().includes(query)));

    const search = el('input', 'input');
    search.type = 'search';
    search.placeholder = 'Teks, nominal atau referensi';
    search.value = view.query;
    search.addEventListener('change', () => {
      view.query = search.value;
      redraw();
    });
    const filters = el('div', 'ops-filters');
    filters.append(
      pills([{ value: '', label: 'Semua' }, ...(Object.keys(STATUS_LABELS) as Status[]).map((status) => ({ value: status, label: STATUS_LABELS[status] }))], view.status, (status) => {
        view.status = status;
        redraw();
      }),
      search,
      act('CSV', 'btn btn-outline btn-sm', () =>
        downloadText(
          toCsv(
            ['Waktu', 'Status', 'Nominal terbaca', 'QR yang dilunasi', 'Total', 'Manual', 'Teks'],
            rows.map((entry) => [new Date(entry.at).toISOString(), STATUS_LABELS[entry.status], entry.amounts.join(' '), entry.key ? reference(entry.key) : '', entry.total ?? '', entry.byHand ? 'ya' : '', entry.text]),
          ),
          'qris-notifications.csv',
        ),
      'download'),
      act('Muat ulang', 'btn btn-ghost btn-sm', redraw),
    );

    part.body.append(
      statRow([
        { label: 'Masuk hari ini', value: String(recent.length), hint: desk.lastSeen ? `Terakhir pukul ${new Date(desk.lastSeen).toLocaleTimeString('id-ID', { timeStyle: 'short' })}` : 'Belum ada' },
        { label: 'Cocok hari ini', value: money(matched.reduce((sum, entry) => sum + (entry.total ?? 0), 0)), hint: `${matched.length} pembayaran` },
        { label: 'Tidak cocok', value: String(open.length), hint: open.length ? 'Buka satu per satu untuk mencocokkannya' : 'Tidak ada yang perlu diperiksa' },
        { label: 'QR menunggu saat ini', value: String(desk.waiting.length) },
      ]),
      filters,
      table<Notification>(
        [
          { label: 'Waktu', cell: (entry) => dateTime(entry.at) },
          { label: 'Status', cell: (entry) => badge(STATUS_LABELS[entry.status], STATUS_KIND[entry.status]) },
          { label: 'Nominal terbaca', cell: (entry) => entry.amounts.map(money).join(', ') || 'Tidak ada' },
          { label: 'QR yang dilunasi', cell: (entry) => (entry.key ? `${reference(entry.key)} · ${money(entry.total ?? 0)}${entry.byHand ? ' · manual' : ''}` : '—') },
          { label: 'Teks', cell: (entry) => entry.text },
          { label: '', cell: (entry) => act(entry.status === 'unmatched' ? 'Cocokkan' : 'Lihat', entry.status === 'unmatched' ? 'btn btn-outline btn-sm' : 'btn btn-ghost btn-sm', () => notificationDialog(entry, desk)) },
        ],
        rows,
        { empty: desk.log.length ? 'Tidak ada notifikasi yang sesuai filter ini.' : 'Belum ada notifikasi yang masuk. Kirim tes dari tab Gateway QRIS.' },
      ),
    );
    return part.root;
  }

  function notificationDialog(entry: Notification, desk: QrisDeskState): void {
    const facts = el('dl', 'facts');
    for (const [label, value] of [
      ['Diterima', dateTime(entry.at)],
      ['Status', `${STATUS_LABELS[entry.status]}${entry.byHand ? ' manual' : ''}`],
      ['Nominal terbaca', entry.amounts.map(money).join(', ') || 'Tidak ada'],
      ['QR yang dilunasi', entry.key ? `${reference(entry.key)} · ${money(entry.total ?? 0)}` : '—'],
      ['Teks', entry.text],
    ]) {
      facts.append(el('dt', '', label), el('dd', '', value));
    }
    const ignore = async () => {
      await post(`log/${entry.id}`, { action: 'ignore' });
      ops.edit('settings.manage', 'payment.qris-ignore', `Notifikasi QRIS diabaikan: "${entry.text.slice(0, 80)}".`, () => {});
    };
    if (entry.status !== 'unmatched') {
      const close = actionButton('Selesai', 'btn btn-primary');
      close.dataset.close = '';
      openDialog({ title: 'Notifikasi QRIS', body: [facts], footer: [close] });
      return;
    }
    if (desk.waiting.length === 0) {
      const dialog = openDialog({
        title: 'Notifikasi tidak cocok',
        description: 'Tidak ada QR yang menunggu, jadi notifikasi ini tidak bisa dicocokkan. Kalau QR pelanggan sudah kedaluwarsa, cari di Pembayaran lalu pakai Tandai lunas. Abaikan notifikasi ini setelah selesai ditangani.',
        body: [facts],
        footer: [
          act('Abaikan', 'btn btn-outline', async () => {
            await ignore();
            dialog.close();
          }),
        ],
      });
      return;
    }
    formDialog({
      title: 'Notifikasi tidak cocok',
      description: `"${entry.text}" tidak cocok dengan QR yang menunggu. Pilih QR yang dibayar pelanggan ini, misalnya bila mereka mengetik nominal lain, lalu booth atau kasirnya menyelesaikan pesanan.`,
      submitLabel: 'Tandai QR itu lunas',
      fields: [{ name: 'key', label: 'QR yang menunggu', value: desk.waiting[0].key, options: desk.waiting.map((qr) => ({ value: qr.key, label: `${reference(qr.key)} · ${money(qr.total)}` })) }],
      danger: {
        label: 'Abaikan',
        run: (close) =>
          void ignore().then(close, (error: Error) => notice(error.message, 'error')),
      },
      async submit(values) {
        const key = String(values.key);
        await post(`log/${entry.id}`, { action: 'match', key });
        ops.edit('settings.manage', 'payment.qris-match', `QRIS ${reference(key)} dilunasi manual dari notifikasi "${entry.text.slice(0, 80)}".`, () => {});
      },
    });
  }

  function waitingQrs(desk: QrisDeskState): HTMLElement {
    const part = section('QR menunggu saat ini', 'Dari semua booth, kiosk dan kasir. Setiap QR memegang totalnya sampai lunas, dibatalkan atau habis waktunya, supaya tidak ada pelanggan lain yang diminta nominal yang sama.');
    part.body.append(
      table<WaitingQr>(
        [
          { label: 'Referensi', cell: (qr) => reference(qr.key) },
          { label: 'Dibayar pelanggan', cell: (qr) => money(qr.total) },
          { label: 'Kode unik', cell: (qr) => (qr.code ? money(qr.code) : '—') },
          { label: 'Berlaku sampai', cell: (qr) => new Date(qr.expiresAt).toLocaleTimeString('id-ID', { timeStyle: 'short' }) },
          {
            label: '',
            cell: (qr) =>
              act('Lepaskan', 'btn btn-ghost btn-sm', async () => {
                const reply = await fetch(`/api/qris/charges/${encodeURIComponent(qr.key)}`, { method: 'DELETE' });
                if (!reply.ok) throw new Error('Komputer booth menolak permintaan itu.');
                ops.edit('settings.manage', 'payment.qris-release', `QRIS ${reference(qr.key)} yang menunggu dilepas: pembayaran ke QR ini tidak akan lunas otomatis lagi.`, () => {});
              }),
          },
        ],
        desk.waiting,
        { empty: 'Tidak ada QR yang menunggu.' },
      ),
    );
    return part.root;
  }
}

/** A new POST address for the forwarding phone; the old one stops working. */
export async function renewQrisToken(): Promise<void> {
  await post('token');
}
