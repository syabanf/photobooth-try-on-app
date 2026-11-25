// Settings: booth categories and their prices, print prices, merchandise, discount presets, booth
// profiles, shifts, retention, payments, ads and events.

import { formDialog } from '../../../dialogs';
import { iconButton } from '../../../icons';
import { putBlob, deleteBlob } from '../../blobs';
import { SESSION_MODES, type SessionMode } from '../../model';
import { PAPER, PAPER_SIZES } from '../../printing';
import { isTimeZone } from '../../time';
import type { PageContext } from '../router';
import { act, badge, el, fileInput, money, notice, page, parseAmount, section, table } from '../kit';

const MODES = Object.keys(SESSION_MODES) as SessionMode[];

export function renderSettings({ ops }: PageContext): HTMLElement {
  const { state } = ops;
  const view = page('Harga dan aturan', 'Harga dan aturan yang diikuti setiap booth dan kasir Dusun Bambu. Lompat ke bagian di bawah, atau kerjakan berurutan dari atas.');

  // ---------- booth categories ----------
  const categories = section('Kategori booth', 'Jenis booth dengan harga sendiri per mode sesi. Setiap booth masuk ke satu kategori.');
  const editCategory = (id?: string) => {
    const category = state.categories.find((entry) => entry.id === id);
    formDialog({
      title: category ? `Ubah ${category.name}` : 'Tambah kategori booth',
      submitLabel: 'Simpan',
      fields: [
        { name: 'name', label: 'Nama', value: category?.name ?? '', placeholder: 'Contoh: Photobox' },
        ...MODES.map((mode) => ({ name: mode, label: `Harga ${SESSION_MODES[mode].label}`, value: String(category?.prices[mode] ?? ''), type: 'number' as const, hint: 'Kosongkan untuk berhenti menjual mode ini.' })),
      ],
      danger: category && state.categories.length > 1 ? { label: 'Hapus', run: (close) => { ops.edit('settings.manage', 'category.delete', `Kategori booth ${category.name} dihapus.`, (draft) => { draft.categories = draft.categories.filter((entry) => entry.id !== id); }); close(); } } : undefined,
      async submit(values) {
        const name = String(values.name).trim();
        if (!name) throw new Error('Isi nama.');
        const prices = Object.fromEntries(MODES.filter((mode) => String(values[mode]).trim()).map((mode) => [mode, parseAmount(String(values[mode]))]));
        ops.edit('settings.manage', 'category.save', `Kategori booth ${name} disimpan.`, (draft) => {
          const existing = draft.categories.find((entry) => entry.id === id);
          if (existing) Object.assign(existing, { name, prices });
          else draft.categories.push({ id: ops.store.id(), name, prices });
        });
      },
    });
  };
  categories.actions.append(act('Tambah kategori', 'btn btn-outline btn-sm', () => editCategory(), 'plus'));
  categories.body.append(
    table(
      [
        { label: 'Kategori', cell: (row) => row.name },
        ...MODES.map((mode) => ({ label: SESSION_MODES[mode].label, className: 'num', cell: (row: (typeof state.categories)[number]) => (row.prices[mode] === undefined ? '—' : money(row.prices[mode]!)) })),
      ],
      state.categories,
      { onRow: (row) => editCategory(row.id) },
    ),
  );

  // ---------- booth profiles ----------
  const booths = section('Booth', 'Kategori, zona waktu dan mode sesi per booth. Voucher dan laporan mengikuti jam masing-masing booth.');
  booths.body.append(
    table(
      [
        { label: 'Booth', cell: (point) => `${point.name} · ${ops.branchName(point.locationId)}` },
        { label: 'Kategori', cell: (point) => state.categories.find((entry) => entry.id === ops.profile(point.id).categoryId)?.name ?? '—' },
        { label: 'Zona waktu', cell: (point) => ops.profile(point.id).timeZone },
        { label: 'Mode', cell: (point) => ops.profile(point.id).modes.map((mode) => SESSION_MODES[mode].label).join(', ') },
      ],
      ops.visibleBooths(),
      {
        empty: 'Tambahkan booth di halaman Lokasi dulu.',
        onRow: (point) => {
          const profile = ops.profile(point.id);
          formDialog({
            title: point.name,
            submitLabel: 'Simpan',
            fields: [
              { name: 'categoryId', label: 'Kategori', value: profile.categoryId, options: state.categories.map((entry) => ({ value: entry.id, label: entry.name })) },
              { name: 'timeZone', label: 'Zona waktu', value: profile.timeZone, hint: 'Nama IANA, misalnya Asia/Jakarta, Asia/Makassar atau Asia/Singapore.' },
              { name: 'modes', label: 'Mode sesi', value: profile.modes, options: MODES.map((mode) => ({ value: mode, label: SESSION_MODES[mode].label })) },
            ],
            async submit(values) {
              const timeZone = String(values.timeZone).trim();
              if (!isTimeZone(timeZone)) throw new Error(`${timeZone} bukan zona waktu.`);
              const modes = values.modes as SessionMode[];
              if (modes.length === 0) throw new Error('Pilih minimal satu mode.');
              ops.saveProfile({ pointId: point.id, categoryId: String(values.categoryId), timeZone, modes });
            },
          });
        },
      },
    ),
  );

  // ---------- print prices ----------
  const prints = section('Harga cetak', 'Harga cetakan tambahan di booth dan di kasir.');
  const editPrint = (size?: string) => {
    const existing = state.printPrices.find((entry) => entry.size === size);
    formDialog({
      title: existing ? `Ubah ${existing.size}` : 'Tambah ukuran cetak',
      submitLabel: 'Simpan',
      fields: [
        { name: 'size', label: 'Ukuran', value: existing?.size ?? '4R', options: PAPER_SIZES.map((paper) => ({ value: paper, label: PAPER[paper].label })) },
        { name: 'price', label: 'Harga', value: String(existing?.price ?? ''), type: 'number' },
      ],
      danger: existing ? { label: 'Hapus', run: (close) => { ops.edit('settings.manage', 'print.delete', `Cetakan ${existing.size} tidak dijual lagi.`, (draft) => { draft.printPrices = draft.printPrices.filter((entry) => entry.size !== size); }); close(); } } : undefined,
      async submit(values) {
        const price = parseAmount(String(values.price));
        if (price <= 0) throw new Error('Isi harga.');
        ops.edit('settings.manage', 'print.save', `Harga cetakan ${values.size} menjadi ${money(price)}.`, (draft) => {
          draft.printPrices = [...draft.printPrices.filter((entry) => entry.size !== values.size && entry.size !== size), { size: values.size as never, price }];
        });
      },
    });
  };
  prints.actions.append(
    act(`Preset AI ${state.settings.presetPrice ? money(state.settings.presetPrice) : 'gratis'}`, 'btn btn-ghost btn-sm', () =>
      formDialog({
        title: 'Cetakan preset AI',
        description: 'Harga yang ditagih booth untuk satu cetakan preset AI. Isi 0 agar gratis.',
        submitLabel: 'Simpan',
        fields: [{ name: 'price', label: 'Harga', value: String(state.settings.presetPrice), type: 'number' }],
        async submit(values) {
          const presetPrice = parseAmount(String(values.price));
          if (presetPrice < 0) throw new Error('Harga tidak boleh negatif.');
          ops.savePresetPrice(presetPrice);
        },
      }), 'sparkles'),
    act('Tambah ukuran', 'btn btn-outline btn-sm', () => editPrint(), 'plus'),
  );
  prints.body.append(table([{ label: 'Ukuran', cell: (row) => PAPER[row.size].label }, { label: 'Harga', className: 'num', cell: (row) => money(row.price) }], state.printPrices, { onRow: (row) => editPrint(row.size) }));

  // ---------- merchandise ----------
  const products = section('Merchandise', 'Dijual di kasir. Stok berkurang di setiap penjualan dan bertambah lagi saat refund.');
  const editProduct = (id?: string) => {
    const product = state.products.find((entry) => entry.id === id);
    formDialog({
      title: product ? `Ubah ${product.name}` : 'Tambah produk',
      submitLabel: 'Simpan',
      fields: [
        { name: 'name', label: 'Nama', value: product?.name ?? '', placeholder: 'Contoh: Gantungan kunci bingkai' },
        { name: 'sku', label: 'SKU', value: product?.sku ?? '' },
        { name: 'price', label: 'Harga', value: String(product?.price ?? ''), type: 'number' },
        { name: 'stock', label: 'Stok', value: String(product?.stock ?? 0), type: 'number' },
      ],
      danger: product ? { label: 'Hapus', run: (close) => { ops.edit('settings.manage', 'product.delete', `${product.name} dihapus.`, (draft) => { draft.products = draft.products.filter((entry) => entry.id !== id); }); close(); } } : undefined,
      async submit(values) {
        const name = String(values.name).trim();
        const price = parseAmount(String(values.price));
        const stock = parseAmount(String(values.stock));
        if (!name || price <= 0) throw new Error('Isi nama dan harga.');
        if (stock < 0) throw new Error('Stok tidak boleh negatif.');
        ops.edit('settings.manage', 'product.save', `${name} ${product ? 'diperbarui' : 'ditambahkan'}, stok ${stock}.`, (draft) => {
          const existing = draft.products.find((entry) => entry.id === id);
          const fields = { name, sku: String(values.sku).trim(), price, stock };
          if (existing) Object.assign(existing, fields);
          else draft.products.push({ id: ops.store.id(), ...fields });
        });
      },
    });
  };
  products.actions.append(act('Tambah produk', 'btn btn-outline btn-sm', () => editProduct(), 'plus'));
  products.body.append(
    table(
      [
        { label: 'Produk', cell: (row) => row.name },
        { label: 'SKU', cell: (row) => row.sku || '—' },
        { label: 'Harga', className: 'num', cell: (row) => money(row.price) },
        { label: 'Stok', className: 'num', cell: (row) => (row.stock === 0 ? badge('Habis', 'error') : String(row.stock)) },
      ],
      state.products,
      { empty: 'Belum ada merchandise.', onRow: (row) => editProduct(row.id) },
    ),
  );

  // ---------- discount presets ----------
  const presets = section('Preset diskon', 'Diskon sekali ketuk di kasir, misalnya harga staf atau paket. Perlu izin diskon.');
  const editPreset = (id?: string) => {
    const preset = state.presets.find((entry) => entry.id === id);
    formDialog({
      title: preset ? `Ubah ${preset.name}` : 'Tambah preset diskon',
      submitLabel: 'Simpan',
      fields: [
        { name: 'name', label: 'Nama', value: preset?.name ?? '', placeholder: 'Contoh: Pelajar 10%' },
        { name: 'kind', label: 'Jenis', value: preset?.kind ?? 'percent', options: [{ value: 'percent', label: 'Diskon persen' }, { value: 'amount', label: 'Diskon rupiah' }] },
        { name: 'value', label: 'Nilai', value: String(preset?.value ?? ''), type: 'number' },
      ],
      danger: preset ? { label: 'Hapus', run: (close) => { ops.edit('settings.manage', 'preset.delete', `Preset ${preset.name} dihapus.`, (draft) => { draft.presets = draft.presets.filter((entry) => entry.id !== id); }); close(); } } : undefined,
      async submit(values) {
        const name = String(values.name).trim();
        const value = parseAmount(String(values.value));
        if (!name || value <= 0) throw new Error('Isi nama dan nilai.');
        if (values.kind === 'percent' && value > 100) throw new Error('Persentase paling tinggi 100.');
        ops.edit('settings.manage', 'preset.save', `Preset ${name} disimpan.`, (draft) => {
          const existing = draft.presets.find((entry) => entry.id === id);
          const fields = { name, kind: values.kind as 'percent' | 'amount', value };
          if (existing) Object.assign(existing, fields);
          else draft.presets.push({ id: ops.store.id(), ...fields });
        });
      },
    });
  };
  presets.actions.append(act('Tambah preset', 'btn btn-outline btn-sm', () => editPreset(), 'plus'));
  presets.body.append(table([{ label: 'Preset', cell: (row) => row.name }, { label: 'Diskon', className: 'num', cell: (row) => (row.kind === 'percent' ? `${row.value}%` : money(row.value)) }], state.presets, { empty: 'Belum ada preset.', onRow: (row) => editPreset(row.id) }));

  // ---------- operations ----------
  const rules = section('Operasional', 'Shift, masa simpan dan antrean.');
  const s = state.settings;
  rules.actions.append(
    act('Ubah', 'btn btn-outline btn-sm', () =>
      formDialog({
        title: 'Operasional',
        submitLabel: 'Simpan',
        fields: [
          { name: 'shiftsEnabled', label: 'Wajib buka shift untuk berjualan', value: s.shiftsEnabled, hint: 'Matikan untuk booth tanpa kasir.' },
          { name: 'retentionDays', label: 'Simpan foto pelanggan selama (hari)', value: String(s.retentionDays), type: 'number', hint: 'Isi 0 untuk menyimpan selamanya. File yang lebih lama dihapus setiap hari; catatan penjualan tetap ada.' },
          { name: 'queuePrefix', label: 'Awalan nomor antrean', value: s.queuePrefix },
          {
            name: 'faceLibrary',
            label: 'Daftar wajah di halaman Preset AI',
            value: s.faceLibrary,
            options: [{ value: 'all', label: 'Semua wajah yang terekam, sampai terhapus oleh masa simpan' }, { value: 'visit', label: 'Hanya wajah pelanggan saat ini' }],
            hint: 'Semua wajah memudahkan pelanggan tetap memakai wajahnya lagi, tetapi setiap pelanggan bisa melihatnya. Pilih yang kedua untuk booth umum.',
          },
          { name: 'receiptFooter', label: 'Catatan kaki struk', value: s.receiptFooter, type: 'textarea' },
        ],
        async submit(values) {
          const retentionDays = parseAmount(String(values.retentionDays));
          if (retentionDays < 0) throw new Error('Masa simpan tidak boleh negatif.');
          ops.edit('settings.manage', 'settings.save', 'Pengaturan operasional diperbarui.', (draft) => {
            Object.assign(draft.settings, {
              shiftsEnabled: values.shiftsEnabled as boolean,
              retentionDays,
              queuePrefix: String(values.queuePrefix).trim().toUpperCase().slice(0, 3) || 'A',
              faceLibrary: values.faceLibrary as 'all' | 'visit',
              receiptFooter: String(values.receiptFooter).trim(),
            });
          });
        },
      }),
    'edit'),
    act('Hapus sekarang', 'btn btn-ghost btn-sm', async () => notice(`${await ops.purgeExpired()} sesi dihapus.`, 'ok')),
  );
  const facts = el('dl', 'facts');
  for (const [label, value] of [
    ['Shift', s.shiftsEnabled ? 'Wajib untuk berjualan' : 'Mati'],
    ['Masa simpan foto', s.retentionDays ? `${s.retentionDays} hari, lalu dihapus` : 'Disimpan selamanya'],
    ['Pembayaran', 'Metode, biaya dan gateway ada di halaman Pembayaran'],
    ['Nomor antrean', `${s.queuePrefix}001, ${s.queuePrefix}002 …`],
    ['Daftar wajah', s.faceLibrary === 'all' ? `Semua wajah yang terekam (${state.faces.length} tersimpan)` : 'Hanya pelanggan saat ini'],
  ]) {
    facts.append(el('dt', '', label), el('dd', '', value));
  }
  rules.body.append(facts);

  // ---------- idle-screen ads ----------
  const ads = section('Iklan layar diam', 'Diputar layar penuh di booth yang sedang menunggu tanpa pelanggan. Satu ketukan kembali ke layar awal.');
  const upload = fileInput('image/*,video/*', async (file) => {
    const src = await putBlob(file);
    ops.edit('branding.manage', 'ad.add', `Iklan ${file.name} ditambahkan.`, (draft) => {
      draft.ads.push({ id: ops.store.id(), name: file.name, kind: file.type.startsWith('video/') ? 'video' : 'image', src, seconds: 8, active: true });
    });
  });
  ads.actions.append(
    upload,
    act('Unggah iklan', 'btn btn-outline btn-sm', () => upload.click(), 'upload'),
    act(s.adsEnabled ? 'Matikan' : 'Nyalakan', 'btn btn-ghost btn-sm', () =>
      ops.edit('branding.manage', 'ads.toggle', `Iklan layar diam ${s.adsEnabled ? 'dihentikan' : 'dimulai'}.`, (draft) => { draft.settings.adsEnabled = !draft.settings.adsEnabled; }),
    ),
    act(`Diam ${s.idleSeconds} detik`, 'btn btn-ghost btn-sm', () =>
      formDialog({
        title: 'Waktu diam',
        submitLabel: 'Simpan',
        fields: [{ name: 'seconds', label: 'Detik tanpa sentuhan sebelum iklan diputar', value: String(s.idleSeconds), type: 'number' }],
        async submit(values) {
          const seconds = parseAmount(String(values.seconds));
          if (seconds < 10) throw new Error('Isi minimal 10 detik.');
          ops.edit('branding.manage', 'ads.idle', `Iklan mulai setelah ${seconds} detik tanpa sentuhan.`, (draft) => { draft.settings.idleSeconds = seconds; });
        },
      }),
    ),
  );
  ads.body.append(
    table(
      [
        { label: 'Iklan', cell: (row) => row.name },
        { label: 'Jenis', cell: (row) => (row.kind === 'video' ? 'Video' : 'Gambar') },
        { label: 'Detik', className: 'num', cell: (row) => (row.kind === 'video' ? 'Klip penuh' : String(row.seconds)) },
        { label: 'Status', cell: (row) => badge(row.active ? 'Diputar' : 'Dijeda', row.active ? 'ok' : 'muted') },
        {
          label: '',
          className: 'actions',
          cell: (row) => {
            const remove = iconButton('trash', `Hapus ${row.name}`);
            remove.addEventListener('click', async () => {
              await deleteBlob(row.src);
              ops.edit('branding.manage', 'ad.delete', `Iklan ${row.name} dihapus.`, (draft) => { draft.ads = draft.ads.filter((entry) => entry.id !== row.id); });
            });
            return remove;
          },
        },
      ],
      state.ads,
      {
        empty: s.adsEnabled ? 'Unggah gambar atau video pendek.' : 'Iklan mati. Unggah beberapa, lalu nyalakan.',
        onRow: (row) => ops.edit('branding.manage', 'ad.toggle', `Iklan ${row.name} ${row.active ? 'dijeda' : 'diputar lagi'}.`, (draft) => { const ad = draft.ads.find((entry) => entry.id === row.id)!; ad.active = !ad.active; }),
      },
    ),
  );

  // ---------- events ----------
  const events = section('Acara', 'Kelompokkan sesi dari satu acara di bawah satu tautan galeri, misalnya pernikahan atau aktivasi merek.');
  const editEvent = (id?: string) => {
    const event = state.events.find((entry) => entry.id === id);
    formDialog({
      title: event ? `Ubah ${event.name}` : 'Tambah acara',
      submitLabel: 'Simpan',
      fields: [
        { name: 'name', label: 'Nama', value: event?.name ?? '', placeholder: 'Contoh: Pernikahan Rani & Dimas' },
        { name: 'from', label: 'Dari', value: event?.from ?? '', type: 'date' },
        { name: 'to', label: 'Sampai', value: event?.to ?? '', type: 'date' },
        { name: 'boothIds', label: 'Booth', value: event?.boothIds ?? [], options: ops.visibleBooths().map((point) => ({ value: point.id, label: point.name })), hint: 'Bila tidak ada yang dicentang, berlaku di semua booth.' },
      ],
      danger: event ? { label: 'Hapus', run: (close) => { ops.edit('settings.manage', 'event.delete', `Acara ${event.name} dihapus.`, (draft) => { draft.events = draft.events.filter((entry) => entry.id !== id); }); close(); } } : undefined,
      async submit(values) {
        const name = String(values.name).trim();
        if (!name) throw new Error('Isi nama.');
        if (values.from && values.to && String(values.to) < String(values.from)) throw new Error('Acara berakhir sebelum dimulai.');
        ops.edit('settings.manage', 'event.save', `Acara ${name} disimpan.`, (draft) => {
          const fields = { name, from: String(values.from), to: String(values.to), boothIds: values.boothIds as string[] };
          const existing = draft.events.find((entry) => entry.id === id);
          if (existing) Object.assign(existing, fields);
          else draft.events.push({ id: ops.store.id(), ...fields });
        });
      },
    });
  };
  events.actions.append(act('Tambah acara', 'btn btn-outline btn-sm', () => editEvent(), 'plus'));
  events.body.append(
    table(
      [
        { label: 'Acara', cell: (row) => row.name },
        { label: 'Tanggal', cell: (row) => [row.from, row.to].filter(Boolean).join(' – ') || 'Tanpa batas' },
        { label: 'Sesi', className: 'num', cell: (row) => String(state.sessions.filter((session) => session.eventId === row.id).length) },
        {
          label: 'Tautan galeri',
          cell: (row) => {
            const link = el('a', 'link', 'Buka');
            link.href = ops.eventLink(row.id);
            link.target = '_blank';
            return link;
          },
        },
      ],
      state.events,
      { empty: 'Belum ada acara.', onRow: (row) => editEvent(row.id) },
    ),
  );

  const parts: [string, string, HTMLElement][] = [
    ['categories', 'Kategori', categories.root],
    ['booths', 'Booth', booths.root],
    ['prints', 'Harga cetak', prints.root],
    ['products', 'Merchandise', products.root],
    ['presets', 'Diskon', presets.root],
    ['rules', 'Operasional', rules.root],
    ['ads', 'Iklan', ads.root],
    ['events', 'Acara', events.root],
  ];
  // A jump bar over the long page: each part keeps an anchor the setup guide links to.
  const jump = el('nav', 'section-jump');
  jump.setAttribute('aria-label', 'Bagian halaman ini');
  for (const [key, label, root] of parts) {
    root.id = `settings-${key}`;
    const link = el('a', 'section-jump-link', label);
    link.href = `#settings-${key}`;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    jump.append(link);
  }
  view.body.append(jump, ...parts.map(([, , root]) => root));
  return view.root;
}
