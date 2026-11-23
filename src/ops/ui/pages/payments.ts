// Payments: every customer payment with its status and actions, and the rules behind them: which
// methods the till and the booth take, the fee each one costs, the QRIS gateway, EDC terminals and
// e-wallets.

import { formDialog, openDialog } from '../../../dialogs';
import { seesBranch } from '../../access';
import { PAYMENT_LABELS, PAYMENT_METHODS, PAYMENT_STATUS_LABELS, type Channel, type PaymentMethod, type PaymentStatus, type Terminal } from '../../model';
import type { Ops } from '../../ops';
import { GATEWAY_NAMES, allowedMethods, gatewayLabel, payable, paymentRows, summarizePayments, type PaymentRow } from '../../payments';
import { toCsv } from '../../reports';
import { lockQrisAmount, qrisPayload, readQris } from '../../encoders';
import type { PageContext } from '../router';
import { loadQrisDesk, qrisHistoryTab, renewQrisToken } from './qris-history';
import { act, actionButton, badge, dateTime, downloadText, el, money, notice, page, pills, qrCanvas, section, statRow, table, type BadgeKind } from '../kit';

type Tab = 'list' | 'methods' | 'gateway' | 'qris' | 'terminals';
const STATUSES: PaymentStatus[] = ['pending', 'paid', 'expired', 'failed', 'cancelled'];
const STATUS_KIND: Record<PaymentStatus, BadgeKind> = { pending: 'warn', paid: 'ok', expired: 'muted', failed: 'error', cancelled: 'muted' };

const view = { tab: 'list' as Tab, status: '' as PaymentStatus | '', method: '' as PaymentMethod | '', channel: '' as Channel | '', branchId: '', query: '' };

/** Opens Payments on a tab, for links from the setup guide. */
export function showPaymentsTab(tab: Tab): void {
  view.tab = tab;
}

export function renderPayments(context: PageContext): HTMLElement {
  const { ops, redraw } = context;
  ops.expirePayments();
  const root = page('Pembayaran', 'Semua pembayaran pelanggan, beserta metode, biaya dan gateway di baliknya.');
  const manages = ops.can('settings.manage');
  const tabs: { value: Tab; label: string }[] = [{ value: 'list', label: 'Pembayaran' }];
  if (manages) tabs.push({ value: 'methods', label: 'Metode dan biaya' }, { value: 'gateway', label: 'Gateway QRIS' }, { value: 'terminals', label: 'Terminal dan e-wallet' });
  // The shop's own QRIS has a trail of its own: what the phone forwarded and what it settled.
  if (manages && ops.payments.gateway.provider === 'static') tabs.splice(3, 0, { value: 'qris', label: 'Notifikasi QRIS' });
  if (!tabs.some((tab) => tab.value === view.tab)) view.tab = 'list';
  if (tabs.length > 1) {
    root.body.append(
      pills(tabs, view.tab, (tab) => {
        view.tab = tab;
        redraw();
      }),
    );
  }
  const draw = { list: paymentList, methods: methodsTab, gateway: gatewayTab, qris: qrisHistoryTab, terminals: terminalsTab }[view.tab];
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
  search.placeholder = 'Pesanan, referensi, e-wallet';
  search.value = view.query;
  search.addEventListener('change', () => {
    view.query = search.value;
    redraw();
  });
  filters.append(
    select('Semua status', STATUSES.map((status) => ({ value: status, label: PAYMENT_STATUS_LABELS[status] })), view.status, (value) => (view.status = value)),
    select('Semua metode', PAYMENT_METHODS.map((method) => ({ value: method, label: PAYMENT_LABELS[method] })), view.method, (value) => (view.method = value)),
    select('Kasir dan booth', [{ value: 'cashier' as Channel, label: 'Kasir' }, { value: 'booth' as Channel, label: 'Booth' }], view.channel, (value) => (view.channel = value)),
    select('Semua cabang', ops.visibleBranches().map((branch) => ({ value: branch.id, label: branch.name })), view.branchId, (value) => (view.branchId = value)),
    search,
    act('CSV', 'btn btn-outline btn-sm', () =>
      downloadText(
        toCsv(
          ['Waktu', 'Pesanan', 'Kanal', 'Cabang', 'Metode', 'Lewat', 'Referensi', 'Jumlah', 'Kode unik', 'Biaya', 'Status', 'Catatan'],
          rows.map(({ payment, order }) => [
            new Date(payment.paidAt ?? payment.createdAt).toISOString(),
            order.number,
            order.channel === 'booth' ? ops.boothName(order.boothId) : 'Kasir',
            ops.branchName(order.branchId),
            PAYMENT_LABELS[payment.method],
            via(ops, payment),
            payment.reference,
            payment.amount,
            payment.uniqueCode ?? 0,
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
      { label: 'Lunas', value: money(summary.paid), hint: `${rows.filter((row) => row.payment.status === 'paid').length} pembayaran` },
      { label: 'Biaya', value: money(summary.fees), hint: 'Sesuai tarif di Metode dan biaya' },
      { label: 'Bersih', value: money(summary.net), hint: summary.refunded ? `${money(summary.refunded)} di-refund` : 'Setelah biaya dan refund' },
      { label: 'Menunggu', value: String(summary.pending), hint: summary.pending ? `${money(summary.pendingAmount)} di QR yang masih terbuka` : 'Tidak ada QR terbuka' },
    ]),
    table(
      [
        { label: 'Waktu', cell: ({ payment }) => dateTime(payment.paidAt ?? payment.createdAt) },
        { label: 'Pesanan', cell: ({ order }) => order.number },
        { label: 'Tempat', cell: ({ order }) => (order.channel === 'booth' ? ops.boothName(order.boothId) : `Kasir · ${ops.branchName(order.branchId)}`) },
        { label: 'Metode', cell: ({ payment }) => [PAYMENT_LABELS[payment.method], via(ops, payment)].filter(Boolean).join(' · ') },
        { label: 'Referensi', cell: ({ payment }) => (payment.reference ? el('span', 'code', payment.reference) : '—') },
        { label: 'Jumlah', className: 'num', cell: ({ payment }) => money(payment.amount) },
        { label: 'Biaya', className: 'num', cell: ({ payment }) => (payment.fee ? money(payment.fee) : '—') },
        { label: 'Status', cell: ({ payment }) => badge(PAYMENT_STATUS_LABELS[payment.status], STATUS_KIND[payment.status]) },
      ],
      rows.slice(0, 400),
      { empty: 'Tidak ada pembayaran yang cocok.', onRow: (row) => paymentDialog(ops, row, nav) },
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
    ['Pesanan', order.number],
    ['Tempat', order.channel === 'booth' ? ops.boothName(order.boothId) : `Kasir · ${ops.branchName(order.branchId)}`],
    ['Metode', [PAYMENT_LABELS[payment.method], via(ops, payment)].filter(Boolean).join(' · ')],
    ['Jumlah', money(payment.amount)],
    ...(payment.uniqueCode ? [['Dibayar pelanggan', `${money(payable(payment))} (kode unik ${money(payment.uniqueCode)})`] as [string, string]] : []),
    ['Biaya', payment.fee ? money(payment.fee) : '—'],
    ['Referensi', payment.reference || '—'],
    ['Dibuat', dateTime(payment.createdAt)],
    ['Lunas', dateTime(payment.paidAt)],
    ['Kedaluwarsa', payment.expiresAt ? dateTime(payment.expiresAt) : '—'],
    ['Catatan', payment.note ?? '—'],
  ];
  if (payment.tendered) rows.splice(4, 0, ['Uang diterima', `${money(payment.tendered)} · kembalian ${money(payment.tendered - payment.amount)}`]);
  for (const [label, value] of rows) facts.append(el('dt', '', label), el('dd', '', value));
  const body: Node[] = [facts];
  if (payment.status === 'pending' && payment.qrString) body.unshift(qrCanvas(payment.qrString, 200));

  const footer: Node[] = [];
  if (payment.status === 'pending') {
    footer.push(
      act('Batalkan QR', 'btn btn-ghost btn-danger', () => {
        dialog.close();
        formDialog({
          title: 'Batalkan QR ini',
          description: 'Pelanggan bisa membayar dengan cara lain atau minta QR baru. Pesanan tetap terbuka.',
          submitLabel: 'Batalkan QR',
          fields: [{ name: 'reason', label: 'Alasan', value: '', placeholder: 'Contoh: Pelanggan pergi' }],
          async submit(values) {
            ops.cancelPayment(order.id, payment.id, String(values.reason));
          },
        });
      }),
      act('Tandai lunas', 'btn btn-outline', () => {
        dialog.close();
        markPaidDialog(ops, order.id, payment.id);
      }),
    );
  }
  const open = actionButton('Buka pesanan', 'btn btn-outline');
  open.addEventListener('click', () => {
    dialog.close();
    nav('sales');
  });
  const close = actionButton('Selesai', 'btn btn-primary');
  close.dataset.close = '';
  footer.push(open, close);
  const dialog = openDialog({ title: `${PAYMENT_LABELS[payment.method]} · ${money(payment.amount)}`, description: `${PAYMENT_STATUS_LABELS[payment.status]} · ${order.number}`, body, footer });
}

/** A supervisor settles a QR by hand, from what the bank or wallet app shows. */
export function markPaidDialog(ops: Ops, orderId: string, paymentId: string): void {
  formDialog({
    title: 'Tandai lunas',
    description: 'Untuk pembayaran yang sudah berhasil di aplikasi bank tetapi tidak pernah tercatat di sini. Supervisor menyetujuinya dengan PIN, dan log menyimpan referensinya.',
    submitLabel: 'Tandai lunas',
    fields: [
      { name: 'reference', label: 'Referensi bank atau e-wallet', value: '', placeholder: 'Contoh: BCA 7781 · 14.02' },
      { name: 'pin', label: 'PIN supervisor', value: '', type: 'password' },
    ],
    async submit(values) {
      await ops.confirmPayment(orderId, paymentId, String(values.reference), String(values.pin));
      notice(`${ops.order(orderId).number} ditandai lunas.`, 'ok');
    },
  });
}

// ---------- methods and fees ----------

function methodsTab({ ops }: PageContext): HTMLElement {
  const { methods } = ops.payments;
  const part = section('Metode dan biaya', 'Di mana setiap metode ditawarkan, dan biaya prosesnya. Biaya dicatat di setiap pembayaran sesuai tarif hari itu dan ditampilkan bersih di laporan.');
  const toggle = (method: PaymentMethod, key: 'enabled' | 'cashier' | 'booth') => {
    const on = methods[method][key];
    return act(on ? 'Nyala' : 'Mati', on ? 'btn btn-secondary btn-sm' : 'btn btn-ghost btn-sm', () =>
      ops.savePaymentSettings((draft) => (draft.methods[method][key] = !on), `${PAYMENT_LABELS[method]}${key === 'enabled' ? '' : key === 'cashier' ? ' di kasir' : ' di booth'} ${on ? 'dimatikan' : 'dinyalakan'}.`),
    );
  };
  part.body.append(
    table(
      [
        { label: 'Metode', cell: (method: PaymentMethod) => PAYMENT_LABELS[method] },
        { label: 'Aktif', cell: (method) => toggle(method, 'enabled') },
        { label: 'Di kasir', cell: (method) => toggle(method, 'cashier') },
        { label: 'Di booth', cell: (method) => toggle(method, 'booth') },
        { label: 'Biaya', className: 'num', cell: (method) => `${methods[method].feePercent}%` },
        {
          label: '',
          className: 'actions',
          cell: (method) =>
            act('Biaya', 'btn btn-ghost btn-sm', () =>
              formDialog({
                title: `Biaya ${PAYMENT_LABELS[method]}`,
                submitLabel: 'Simpan',
                fields: [{ name: 'fee', label: 'Biaya proses (%)', value: String(methods[method].feePercent), type: 'number', hint: 'MDR QRIS 0,7% untuk sebagian besar merchant; kartu dan e-wallet 1,5% sampai 2%.' }],
                async submit(values) {
                  const fee = Number(values.fee);
                  if (!(fee >= 0 && fee <= 10)) throw new Error('Isi biaya antara 0 dan 10 persen.');
                  ops.savePaymentSettings((draft) => (draft.methods[method].feePercent = fee), `Biaya ${PAYMENT_LABELS[method]} diatur ke ${fee}%.`);
                },
              }),
            ),
        },
      ],
      PAYMENT_METHODS,
    ),
    el('p', 'field-hint', `Kasir menerima ${allowedMethods(ops.payments, 'cashier').map((m) => PAYMENT_LABELS[m]).join(', ') || 'tidak ada'}; booth menerima ${allowedMethods(ops.payments, 'booth').map((m) => PAYMENT_LABELS[m]).join(', ') || 'tidak ada'}.`),
  );
  return part.root;
}

// ---------- gateway ----------

function gatewayTab(context: PageContext): HTMLElement {
  const { ops } = context;
  const { gateway } = ops.payments;
  if (gateway.provider === 'static') return staticTab(context);
  const box = el('div', 'ops-body');
  const part = section('Gateway QRIS', 'Penyedia yang menerbitkan QR dinamis dan melaporkan pembayaran kembali. Aplikasi hanya menyimpan client key; server key tetap di server Anda.');
  part.actions.append(
    act('Ubah', 'btn btn-outline btn-sm', () =>
      formDialog({
        title: 'Gateway QRIS',
        submitLabel: 'Simpan',
        fields: [
          { name: 'provider', label: 'Penyedia', value: gateway.provider, options: (Object.keys(GATEWAY_NAMES) as (keyof typeof GATEWAY_NAMES)[]).filter((key) => key !== 'static').map((key) => ({ value: key, label: GATEWAY_NAMES[key] })) },
          { name: 'mode', label: 'Mode', value: gateway.mode, options: [{ value: 'sandbox', label: 'Sandbox (uang uji coba)' }, { value: 'production', label: 'Produksi (uang sungguhan)' }] },
          { name: 'merchantId', label: 'Merchant ID', value: gateway.merchantId },
          { name: 'clientKey', label: 'Client key', value: gateway.clientKey, type: 'password', hint: 'Kunci publik yang aman untuk browser. Jangan tempel server key di sini.' },
          { name: 'qrExpiryMinutes', label: 'Masa berlaku QR (menit)', value: String(gateway.qrExpiryMinutes), type: 'number' },
        ],
        async submit(values) {
          const minutes = Number(values.qrExpiryMinutes);
          if (!(minutes >= 1 && minutes <= 120)) throw new Error('Isi 1 sampai 120 menit.');
          const key = String(values.clientKey).trim();
          if (/server|secret/i.test(key) || /^SB-Mid-server|^Mid-server|^xnd_(development|production)_/.test(key)) throw new Error('Itu tampaknya server key. Simpan di server dan tempel client key di sini.');
          ops.savePaymentSettings((draft) => {
            Object.assign(draft.gateway, { provider: values.provider as never, mode: values.mode as never, merchantId: String(values.merchantId).trim(), clientKey: key, qrExpiryMinutes: minutes });
          }, `Gateway diatur ke ${GATEWAY_NAMES[values.provider as keyof typeof GATEWAY_NAMES]} ${values.mode}.`);
        },
      }),
    'edit'),
    act('QR uji', 'btn btn-ghost btn-sm', () => {
      const sample = qrisPayload({ merchantName: ops.state.branding.brandName || ops.account.business, merchantCity: ops.sites.locations[0]?.city || 'JAKARTA', merchantId: gateway.merchantId || 'TEST', amount: 1000, reference: 'TEST-QR' });
      const close = actionButton('Selesai', 'btn btn-primary');
      close.dataset.close = '';
      openDialog({ title: 'QR uji', description: `QR Rp1.000 dengan format ${gatewayLabel(ops.payments)}. Di versi ini QR tersebut tidak bisa dibayar; setelah integrasi server aktif, aplikasi sandbox bisa membayarnya.`, body: [qrCanvas(sample, 220)], footer: [close] });
    }, 'qr'),
  );
  const facts = el('dl', 'facts');
  for (const [label, value] of [
    ['Penyedia', gatewayLabel(ops.payments)],
    ['Merchant ID', gateway.merchantId || 'Belum diisi'],
    ['Client key', gateway.clientKey ? `${gateway.clientKey.slice(0, 6)}…` : 'Belum diisi'],
    ['Masa berlaku QR', `${gateway.qrExpiryMinutes} menit`],
    ['Di versi ini', 'Simulasi: format QR sudah benar, tidak ada uang yang berpindah, dan "Simulasikan pembayaran" menggantikan callback.'],
  ]) {
    facts.append(el('dt', '', label), el('dd', '', value));
  }
  part.body.append(facts);
  if (gateway.mode === 'production') part.body.append(badge('Mode produksi: tagihan sungguhan begitu integrasi server aktif', 'warn'));
  box.append(routeChoice(ops), part.root);
  return box;
}

// ---------- the shop's own QRIS ----------

/** The first decision on the tab: the shop's own QRIS, or a gateway. Switching asks first. */
function routeChoice(ops: Ops): HTMLElement {
  const { gateway } = ops.payments;
  const own = gateway.provider === 'static';
  const part = section('Cara pelanggan membayar dengan QRIS', 'QRIS milik toko langsung masuk ke rekening Anda tanpa biaya gateway, dan butuh ponsel Android yang meneruskan notifikasi pembayaran. Gateway (Midtrans, Xendit, DOKU) melaporkan pembayaran sendiri dan merupakan jalur resmi.');
  part.body.append(
    pills([{ value: 'own', label: 'QRIS milik toko' }, { value: 'gateway', label: 'Gateway pembayaran' }], own ? 'own' : 'gateway', (route) => {
      if ((route === 'own') === own) return;
      if (route === 'own' && !gateway.staticQris) return addShopQris(ops);
      formDialog({
        title: route === 'own' ? 'Beralih ke QRIS milik toko' : 'Beralih ke gateway',
        description: route === 'own' ? 'QR baru akan membayar ke QRIS toko, dan ponsel penerus notifikasi harus menyala. QR yang sudah tampil di layar tidak berubah.' : 'QR baru akan dibuat oleh gateway. QRIS toko tetap tersimpan untuk nanti. QR yang sudah tampil di layar tidak berubah.',
        submitLabel: 'Beralih',
        fields: [],
        async submit() {
          ops.savePaymentSettings((draft) => (draft.gateway.provider = route === 'own' ? 'static' : 'midtrans'), route === 'own' ? 'QRIS diatur ke kode milik toko.' : 'QRIS dikembalikan ke gateway.');
        },
      });
    }),
  );
  return part.root;
}

type Detector = new (options: { formats: string[] }) => { detect(image: ImageBitmap): Promise<{ rawValue: string }[]> };

/** Reads the shop QRIS out of a photo or screenshot, with the browser's own QR reader. */
async function qrisFromImage(file: File): Promise<string> {
  const reader = new (window as unknown as { BarcodeDetector: Detector }).BarcodeDetector({ formats: ['qr_code'] });
  const [found] = await reader.detect(await createImageBitmap(file));
  if (!found) throw new Error('Tidak ada kode QR di gambar itu. Coba foto yang lebih tajam dan lurus.');
  readQris(found.rawValue);
  return found.rawValue;
}

/** Adding the shop QRIS: from a picture where this browser can read one, otherwise by pasting. */
function addShopQris(ops: Ops): void {
  if (!('BarcodeDetector' in window)) return staticDialog(ops);
  const picker = el('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.hidden = true;
  const failed = el('p', 'field-error');
  failed.hidden = true;
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    if (!file) return;
    qrisFromImage(file).then(
      (code) => {
        dialog.close();
        staticDialog(ops, code);
      },
      (error: Error) => {
        failed.textContent = error.message;
        failed.hidden = false;
      },
    );
  });
  const dialog = openDialog({
    title: 'Tambah QRIS toko',
    description: 'Foto stiker atau standee QRIS di kasir, atau pakai gambar dari bank, lalu kodenya dibaca dari gambar itu. Tidak ada yang diunggah: gambar tetap di komputer ini.',
    body: [picker, failed],
    footer: [
      act('Tempel teks kode saja', 'btn btn-ghost', () => {
        dialog.close();
        staticDialog(ops);
      }),
      act('Pilih gambar', 'btn btn-primary', () => picker.click(), 'qr'),
    ],
  });
}

function staticDialog(ops: Ops, scanned = ''): void {
  const { gateway } = ops.payments;
  formDialog({
    title: 'QRIS milik toko',
    description: scanned ? `Terbaca dari gambar: QRIS ini membayar ke ${readQris(scanned).merchantName}. Periksa pengaturan di bawah lalu simpan.` : 'Tempel teks di dalam kode QRIS toko (pindai kode cetaknya dengan pembaca QR apa saja untuk mendapatkannya). Uang langsung masuk ke rekening Anda; komputer booth tahu uangnya masuk dari notifikasi yang diteruskan ponsel.',
    submitLabel: 'Simpan',
    fields: [
      { name: 'staticQris', label: 'Teks kode QRIS', value: scanned || gateway.staticQris, type: 'textarea', placeholder: '00020101021126…6304ABCD' },
      { name: 'lockAmount', label: 'Kunci nominal di QR', value: gateway.lockAmount, hint: 'Matikan untuk GoPay Merchant, yang hanya mengirim notifikasi bila pelanggan mengetik nominalnya.' },
      { name: 'uniqueCode', label: 'Kode unik', value: gateway.uniqueCode, options: [{ value: 'collision', label: 'Hanya bila dua pelanggan membayar nominal yang sama' }, { value: 'always', label: 'Di setiap pembayaran (Rp1 sampai Rp99)' }], hint: 'Tambahan beberapa rupiah, supaya setiap notifikasi menunjuk satu pesanan. Pilih "setiap pembayaran" bila kasir lain memakai QRIS yang sama.' },
      { name: 'qrExpiryMinutes', label: 'Masa berlaku QR (menit)', value: String(gateway.qrExpiryMinutes), type: 'number' },
    ],
    async submit(values) {
      const minutes = Number(values.qrExpiryMinutes);
      if (!(minutes >= 1 && minutes <= 120)) throw new Error('Isi 1 sampai 120 menit.');
      const code = String(values.staticQris).trim();
      const { merchantName } = readQris(code);
      ops.savePaymentSettings((draft) => {
        Object.assign(draft.gateway, { provider: 'static', staticQris: code, lockAmount: values.lockAmount === true, uniqueCode: values.uniqueCode as never, qrExpiryMinutes: minutes });
      }, `QRIS diatur ke kode milik toko (${merchantName}).`);
    },
  });
}

function staticTab({ ops, redraw }: PageContext): HTMLElement {
  const { gateway } = ops.payments;
  const box = el('div', 'ops-body');
  const shop = readQris(gateway.staticQris);

  const part = section('QRIS milik toko', 'Pelanggan membayar ke QRIS toko dan uangnya langsung masuk ke rekening Anda. Tidak ada gateway yang menahan atau melaporkannya: komputer booth mencocokkan setiap pembayaran dengan notifikasi yang diteruskan ponsel.');
  part.actions.append(
    act('Ubah', 'btn btn-outline btn-sm', () => staticDialog(ops), 'edit'),
    act('Ganti QRIS', 'btn btn-ghost btn-sm', () => addShopQris(ops)),
    act('QR uji', 'btn btn-ghost btn-sm', () => {
      const close = actionButton('Selesai', 'btn btn-primary');
      close.dataset.close = '';
      openDialog({ title: 'Test QR', description: `QR sungguhan Rp1.000 ke ${shop.merchantName}. Pindai untuk memeriksa nama dan nominal. Membayarnya mengirim Rp1.000 ke rekening Anda sendiri.`, body: [qrCanvas(gateway.lockAmount ? lockQrisAmount(gateway.staticQris, 1000) : gateway.staticQris, 220)], footer: [close] });
    }, 'qr'),
  );
  const facts = el('dl', 'facts');
  for (const [label, value] of [
    ['Penerima', `${shop.merchantName} · ${shop.merchantCity}`],
    ['Nominal', gateway.lockAmount ? 'Terkunci di QR' : 'Diketik pelanggan'],
    ['Kode unik', gateway.uniqueCode === 'always' ? 'Di setiap pembayaran' : 'Hanya bila dua pelanggan membayar nominal yang sama'],
    ['Masa berlaku QR', `${gateway.qrExpiryMinutes} menit`],
  ]) {
    facts.append(el('dt', '', label), el('dd', '', value));
  }
  part.body.append(
    facts,
    el('p', 'callout', 'Periksa dulu ketentuan penerbit QRIS Anda: mengunci nominal di QRIS statis di luar sistem penerbit belum tentu diizinkan oleh setiap penerbit atau aturan Bank Indonesia. Gateway (Midtrans, Xendit, DOKU) adalah jalur resmi.'),
  );

  const phone = section('Ponsel penerus notifikasi', 'Ponsel Android yang menerima notifikasi "dana masuk" dari bank atau e-wallet meneruskan setiap notifikasi ke komputer booth, yang lalu melunasi QR yang cocok. Tanpa ponsel ini, setiap pembayaran harus ditandai lunas manual.');
  phone.body.append(el('p', 'card-desc', 'Memeriksa komputer booth…'));
  void loadQrisDesk().then((desk) => {
    if (typeof desk === 'string') return phone.body.replaceChildren(el('p', 'callout', desk));
    const address = `${desk.origin}/api/qris/mutations/${desk.token}`;
    const quiet = desk.lastContact === null ? null : Date.now() - desk.lastContact;
    const status =
      quiet === null ? badge('Belum terhubung', 'warn')
      : quiet > 30 * 60_000 ? badge(`Tidak ada kabar sejak ${dateTime(desk.lastContact!)}`, 'warn')
      : badge(`Terhubung · kabar terakhir ${new Date(desk.lastContact!).toLocaleTimeString('id-ID', { timeStyle: 'short' })}`, 'ok');
    const sendTest = async () => {
      const reply = await fetch(`/api/qris/mutations/${desk.token}`, { method: 'POST', body: `Tes dari komputer booth pukul ${new Date().toLocaleTimeString('id-ID')}: Rp 1` });
      notice(reply.ok ? 'Komputer booth menerima tes. Tes ada di Notifikasi QRIS, berstatus tidak cocok.' : 'Tes tidak sampai.', reply.ok ? 'ok' : 'error');
      redraw();
    };
    const actions = el('div', 'ops-filters');
    actions.append(
      act('Siapkan ponsel', 'btn btn-primary btn-sm', () => {
        const steps = el('ol', 'qris-steps');
        for (const step of [
          'Di ponsel Android yang menerima notifikasi pembayaran, pasang MacroDroid (atau Tasker) dari Play Store dan beri akses notifikasi.',
          'Pindai QR di atas dengan kamera ponsel dan salin alamat yang muncul. Alamatnya panjang, jadi jangan diketik.',
          'Buat macro "Pembayaran QRIS". Pemicu: notifikasi diterima dari aplikasi pembayaran (DANA, GoPay Merchant, bank Anda). Aksi: HTTP request, metode POST, ke alamat tadi, dengan judul dan teks notifikasi sebagai body.',
          'Buat macro "Masih aktif". Pemicu: setiap 15 menit. Aksi: HTTP request, metode POST, ke alamat yang sama, dengan body ping. Layar kasir lalu memperingatkan kasir bila ponsel tidak memberi kabar.',
          'Di pengaturan baterai ponsel, atur aplikasinya ke tanpa batasan, supaya Android tidak menghentikannya.',
          'Tutup jendela ini, lalu tekan Kirim tes di sini, atau bayar Rp1 ke QRIS toko. Status di atas berubah menjadi Terhubung.',
        ]) steps.append(el('li', '', step));
        const layout = el('div', 'qris-setup');
        layout.append(qrCanvas(address, 220), steps);
        const close = actionButton('Selesai', 'btn btn-primary');
        close.dataset.close = '';
        openDialog({ title: 'Siapkan ponsel penerus notifikasi', description: 'Sekitar sepuluh menit, sekali saja. Alamat ini berisi rahasia: siapa pun yang memilikinya bisa menandai QR yang menunggu sebagai lunas, jadi tunjukkan hanya ke ponsel ini.', body: [layout], footer: [close] });
      }, 'qr'),
      act('Kirim tes', 'btn btn-outline btn-sm', sendTest),
      act('Salin alamat', 'btn btn-ghost btn-sm', async () => {
        await navigator.clipboard.writeText(address);
        notice('Alamat disalin. Alamat ini berisi rahasia: bagikan hanya ke ponsel penerus notifikasi.', 'ok');
      }),
      act('Alamat baru', 'btn btn-ghost btn-sm', () =>
        formDialog({
          title: 'Buat alamat baru',
          description: 'Untuk ponsel yang hilang atau alamat yang sudah dilihat orang lain. Alamat lama langsung tidak berlaku, dan ponsel penerus notifikasi perlu alamat baru sebelum pembayaran bisa lunas otomatis lagi.',
          submitLabel: 'Buat alamat baru',
          fields: [],
          async submit() {
            await renewQrisToken();
            ops.edit('settings.manage', 'payment.qris-token', 'Alamat notifikasi QRIS diperbarui.', () => {});
          },
        }),
      ),
    );
    const details = el('dl', 'facts');
    const state = el('dd');
    state.append(status);
    details.append(el('dt', '', 'Ponsel'), state, el('dt', '', 'Notifikasi pembayaran terakhir'), el('dd', '', desk.lastSeen ? dateTime(desk.lastSeen) : 'Belum ada'));
    phone.body.replaceChildren(
      details,
      actions,
      el('p', 'field-hint', 'Pisahkan Wi-Fi booth dari Wi-Fi tamu, karena alamat ini lewat jaringan itu. Notifikasi yang masuk dan pembayaran yang dilunasinya ada di Notifikasi QRIS.'),
    );
  });

  box.append(routeChoice(ops), part.root, phone.root);
  return box;
}

// ---------- terminals and e-wallets ----------

function terminalsTab({ ops }: PageContext): HTMLElement {
  const box = el('div', 'ops-body');
  const terminals = section('Terminal EDC', 'Mesin kartu per cabang. Kasir mencatat mesin mana yang menerima pembayaran kartu.');
  const editTerminal = (terminal?: Terminal) =>
    formDialog({
      title: terminal ? `Ubah ${terminal.name}` : 'Tambah terminal',
      submitLabel: 'Simpan',
      fields: [
        { name: 'name', label: 'Nama', value: terminal?.name ?? '', placeholder: 'Contoh: EDC 1' },
        { name: 'branchId', label: 'Cabang', value: terminal?.branchId ?? ops.visibleBranches()[0]?.id ?? '', options: ops.visibleBranches().map((branch) => ({ value: branch.id, label: branch.name })) },
        { name: 'provider', label: 'Bank atau acquirer', value: terminal?.provider ?? '', placeholder: 'Contoh: BCA' },
      ],
      danger: terminal ? { label: 'Hapus', run: (close) => { ops.savePaymentSettings((draft) => { draft.terminals = draft.terminals.filter((entry) => entry.id !== terminal.id); }, `Terminal ${terminal.name} dihapus.`); close(); } } : undefined,
      async submit(values) {
        const name = String(values.name).trim();
        if (!name) throw new Error('Isi nama.');
        if (!values.branchId) throw new Error('Tambahkan lokasi dulu.');
        ops.savePaymentSettings((draft) => {
          const fields = { name, branchId: String(values.branchId), provider: String(values.provider).trim() };
          const existing = draft.terminals.find((entry) => entry.id === terminal?.id);
          if (existing) Object.assign(existing, fields);
          else draft.terminals.push({ id: ops.store.id(), ...fields });
        }, `Terminal ${name} disimpan.`);
      },
    });
  terminals.actions.append(act('Tambah terminal', 'btn btn-outline btn-sm', () => editTerminal(), 'plus'));
  terminals.body.append(
    table(
      [
        { label: 'Terminal', cell: (terminal: Terminal) => terminal.name },
        { label: 'Cabang', cell: (terminal) => ops.branchName(terminal.branchId) },
        { label: 'Acquirer', cell: (terminal) => terminal.provider || '—' },
      ],
      ops.payments.terminals,
      { empty: 'Belum ada terminal. Pembayaran kartu tetap mencatat kode approval-nya.', onRow: editTerminal },
    ),
  );

  const wallets = section('E-wallet', 'Merek yang bisa dipilih kasir saat pelanggan membayar dari aplikasi e-wallet.');
  wallets.actions.append(
    act('Tambah e-wallet', 'btn btn-outline btn-sm', () =>
      formDialog({
        title: 'Tambah e-wallet',
        submitLabel: 'Tambah',
        fields: [{ name: 'name', label: 'Nama', value: '', placeholder: 'Contoh: LinkAja' }],
        async submit(values) {
          const name = String(values.name).trim();
          if (!name) throw new Error('Isi nama.');
          if (ops.payments.wallets.some((wallet) => wallet.toLowerCase() === name.toLowerCase())) throw new Error(`${name} sudah ada di daftar.`);
          ops.savePaymentSettings((draft) => draft.wallets.push(name), `E-wallet ${name} ditambahkan.`);
        },
      }),
    'plus'),
  );
  const chips = el('div', 'check-group');
  for (const wallet of ops.payments.wallets) {
    const chip = el('span', 'check', wallet);
    const remove = actionButton('×', 'btn btn-ghost btn-sm');
    remove.setAttribute('aria-label', `Hapus ${wallet}`);
    remove.addEventListener('click', () => ops.savePaymentSettings((draft) => { draft.wallets = draft.wallets.filter((entry) => entry !== wallet); }, `E-wallet ${wallet} dihapus.`));
    chip.append(remove);
    chips.append(chip);
  }
  if (ops.payments.wallets.length === 0) chips.append(el('p', 'card-desc', 'Belum ada e-wallet; kasir hanya mencatat referensinya.'));
  wallets.body.append(chips);
  box.append(terminals.root, wallets.root);
  return box;
}
