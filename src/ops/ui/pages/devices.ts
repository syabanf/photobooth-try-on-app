// Devices: booth health (heartbeat, camera, version), printers and paper, camera profiles, open
// alerts, who hears about them, and the messages sent.

import { formDialog } from '../../../dialogs';
import { APERTURE_STEPS, ISO_STEPS, SHUTTER_STEPS, SimulatedEdsdk } from '../../adapters';
import { ALERT_LABELS, type CameraProfile, type CameraSettings, type NotifyChannel, type PaperSize, type Printer, type RoutingRule } from '../../model';
import { PAPER, PAPER_SIZES, paperState } from '../../printing';
import { ALERT_KINDS, isOnline } from '../../telemetry';
import { cameraSetupDialog } from '../../../dslr/setup-dialog';
import type { PageContext } from '../router';
import { act, badge, dateTime, el, notice, page, parseAmount, pills, section, table } from '../kit';

type Tab = 'health' | 'printers' | 'cameras' | 'alerts' | 'routing' | 'messages';
const view = { tab: 'health' as Tab };

/** Opens Devices on a tab, for links from the setup guide. */
export function showDevicesTab(tab: Tab): void {
  view.tab = tab;
}

export function renderDevices({ ops, redraw }: PageContext): HTMLElement {
  const { state } = ops;
  const root = page('Perangkat', 'Booth melaporkan sinyal aktif, kamera, dan versinya. Printer menghitung kertas, dan peringatan sampai ke orang sesuai aturan tiap cabang.');
  const open = state.alerts.filter((alert) => !alert.resolvedAt);
  root.body.append(
    pills(
      [
        { value: 'health', label: 'Booth' },
        { value: 'printers', label: 'Printer' },
        { value: 'cameras', label: 'Kamera' },
        { value: 'alerts', label: open.length ? `Peringatan (${open.length})` : 'Peringatan' },
        { value: 'routing', label: 'Penerima peringatan' },
        { value: 'messages', label: 'Pesan terkirim' },
      ] as const,
      view.tab,
      (tab) => {
        view.tab = tab;
        redraw();
      },
    ),
  );
  const booths = ops.visibleBooths();
  const device = ops.hooks.devicePointId();

  if (view.tab === 'health') {
    root.body.append(
      table(
        [
          { label: 'Booth', cell: (point) => `${point.name}${point.id === device ? ' (perangkat ini)' : ''}` },
          { label: 'Cabang', cell: (point) => ops.branchName(point.locationId) },
          {
            label: 'Status',
            cell: (point) => {
              const health = state.health.find((entry) => entry.boothId === point.id);
              if (!health) return badge('Belum pernah melapor', 'muted');
              return isOnline(health, Date.now()) ? badge('Online', 'ok') : badge('Offline', 'error');
            },
          },
          { label: 'Sinyal terakhir', cell: (point) => dateTime(state.health.find((entry) => entry.boothId === point.id)?.lastHeartbeat) },
          {
            label: 'Kamera',
            cell: (point) => {
              const health = state.health.find((entry) => entry.boothId === point.id);
              if (!health) return '—';
              if (!health.cameraConnected) return badge('Terputus', 'error');
              return health.cameraBattery === null ? badge('Terhubung', 'ok') : badge(`Baterai ${health.cameraBattery}%`, health.cameraBattery <= 20 ? 'warn' : 'ok');
            },
          },
          { label: 'Versi', cell: (point) => ops.installedVersion(point.id) },
        ],
        booths,
        { empty: 'Tambah booth di halaman Lokasi.' },
      ),
      el('p', 'field-hint', 'Booth dianggap offline dua menit setelah sinyal terakhirnya. Perangkat yang terhubung ke booth mengirim sinyal setiap 30 detik selama aplikasi terbuka.'),
    );
  } else if (view.tab === 'printers') {
    root.actions.append(act('Tambah printer', 'btn btn-primary', () => editPrinter(ops), 'plus'));
    root.body.append(
      table(
        [
          { label: 'Printer', cell: (printer) => `${printer.name} · ${printer.brand === 'dnp' ? 'DNP' : 'Lainnya'}` },
          { label: 'Booth', cell: (printer) => printer.boothIds.map((id) => ops.boothName(id)).join(', ') || '—' },
          { label: 'Ukuran', cell: (printer) => printer.sizes.join(', ') },
          {
            label: 'Kertas',
            className: 'num',
            cell: (printer) => {
              const state = paperState(printer);
              return badge(`sisa ${printer.paperLeft}`, state === 'ok' ? 'ok' : state === 'low' ? 'warn' : 'error');
            },
          },
          { label: 'Status', cell: (printer) => (printer.status === 'ok' ? badge('Siap', 'ok') : badge(printer.error || 'Error', 'error')) },
          {
            label: '',
            className: 'actions',
            cell: (printer) => {
              const box = el('div', 'row-actions');
              box.append(
                act(printer.brand === 'dnp' ? 'Baca jumlah' : 'Hitung kertas', 'btn btn-ghost btn-sm', () => paperDialog(ops, printer)),
                act(printer.status === 'ok' ? 'Simulasikan error' : 'Hapus error', 'btn btn-ghost btn-sm', () =>
                  ops.edit('devices.manage', 'printer.status', `${printer.name}: ${printer.status === 'ok' ? 'error dilaporkan' : 'kembali siap'}.`, (draft) => {
                    const target = draft.printers.find((entry) => entry.id === printer.id)!;
                    target.status = printer.status === 'ok' ? 'error' : 'ok';
                    target.error = printer.status === 'ok' ? 'Pita habis' : '';
                  }),
                ),
              );
              return box;
            },
          },
        ],
        state.printers,
        { empty: 'Belum ada printer. Tambah satu per booth, atau pakai satu printer bersama untuk beberapa booth.', onRow: (printer) => editPrinter(ops, printer) },
      ),
      el('p', 'field-hint', 'Printer DNP melaporkan sisa kertas lewat SDK-nya. Merek lain mulai dari hitungan manual yang berkurang setiap kali mencetak. Peringatan muncul saat mencapai batas bawah.'),
    );
  } else if (view.tab === 'cameras') {
    root.body.append(camerasTab(ops, booths, device, redraw));
  } else if (view.tab === 'alerts') {
    root.body.append(
      table(
        [
          { label: 'Dibuka', cell: (alert) => dateTime(alert.openedAt) },
          { label: 'Peringatan', cell: (alert) => badge(ALERT_LABELS[alert.kind], alert.resolvedAt ? 'muted' : 'error') },
          { label: 'Keterangan', cell: (alert) => alert.message },
          { label: 'Cabang', cell: (alert) => ops.branchName(alert.branchId) },
          { label: 'Selesai', cell: (alert) => (alert.resolvedAt ? dateTime(alert.resolvedAt) : badge('Terbuka', 'warn')) },
        ],
        [...state.alerts].reverse().slice(0, 200),
        { empty: 'Tidak ada peringatan. Peringatan muncul dari kertas, error printer, kamera, dan booth yang tidak mengirim sinyal.' },
      ),
    );
  } else if (view.tab === 'routing') {
    root.actions.append(act('Tambah aturan', 'btn btn-primary', () => editRule(ops), 'plus'));
    root.body.append(
      el('p', 'card-desc', 'Tanpa aturan untuk sebuah cabang, setiap peringatan muncul di booth dan dikirim lewat email dan WhatsApp ke pemilik dan staf yang bertugas di sana. Aturan cabang menggantikannya untuk peringatan yang dipilih.'),
      table(
        [
          { label: 'Cabang', cell: (rule) => (rule.branchId ? ops.branchName(rule.branchId) : 'Semua cabang') },
          { label: 'Peringatan', cell: (rule) => rule.kinds.map((kind) => ALERT_LABELS[kind]).join(', ') },
          { label: 'Saluran', cell: (rule) => rule.channels.map((c) => ({ popup: 'Popup di booth', email: 'Email', whatsapp: 'WhatsApp' })[c]).join(', ') },
          { label: 'Penerima', cell: (rule) => rule.recipients.map((r) => (r === 'owner' ? 'Pemilik' : r === 'on-duty' ? 'Staf bertugas' : state.staff.find((p) => p.id === r)?.name ?? '?')).join(', ') },
        ],
        state.rules,
        { empty: 'Memakai aturan bawaan.', onRow: (rule) => editRule(ops, rule) },
      ),
    );
  } else {
    root.body.append(
      el('p', 'card-desc', 'Email dan pesan WhatsApp yang dikirim aplikasi: peringatan, panggilan antrean, struk, dan tautan foto. Versi ini mencatatnya di sini. Server mengirimnya lewat penyedia email dan WhatsApp Business Anda.'),
      table(
        [
          { label: 'Waktu', cell: (message) => dateTime(message.at) },
          { label: 'Saluran', cell: (message) => badge(message.channel === 'email' ? 'Email' : 'WhatsApp', 'info') },
          { label: 'Kepada', cell: (message) => message.to },
          { label: 'Pesan', cell: (message) => message.body },
        ],
        state.notifications.slice(0, 200),
        { empty: 'Belum ada yang terkirim.' },
      ),
    );
  }
  return root.root;
}

function editPrinter(ops: PageContext['ops'], printer?: Printer): void {
  formDialog({
    title: printer ? `Ubah ${printer.name}` : 'Tambah printer',
    submitLabel: 'Simpan',
    fields: [
      { name: 'name', label: 'Nama', value: printer?.name ?? '', placeholder: 'Contoh: DNP DS-RX1HS' },
      { name: 'brand', label: 'Merek', value: printer?.brand ?? 'dnp', options: [{ value: 'dnp', label: 'DNP (jumlah kertas dari SDK)' }, { value: 'other', label: 'Lainnya (hitung manual)' }] },
      { name: 'boothIds', label: 'Booth', value: printer?.boothIds ?? [], options: ops.visibleBooths().map((point) => ({ value: point.id, label: point.name })), hint: 'Centang beberapa untuk memakai satu printer bersama.' },
      { name: 'sizes', label: 'Ukuran', value: printer?.sizes ?? ['4R'], options: PAPER_SIZES.map((size) => ({ value: size, label: PAPER[size].label })) },
      { name: 'paperLeft', label: 'Sisa kertas', value: String(printer?.paperLeft ?? 400), type: 'number' },
      { name: 'lowThreshold', label: 'Peringatan di bawah', value: String(printer?.lowThreshold ?? 50), type: 'number' },
    ],
    danger: printer ? { label: 'Hapus', run: (close) => { ops.edit('devices.manage', 'printer.delete', `Printer ${printer.name} dihapus.`, (draft) => { draft.printers = draft.printers.filter((entry) => entry.id !== printer.id); }); close(); } } : undefined,
    async submit(values) {
      const name = String(values.name).trim();
      const boothIds = values.boothIds as string[];
      const sizes = values.sizes as PaperSize[];
      if (!name) throw new Error('Isi nama.');
      if (boothIds.length === 0) throw new Error('Pilih minimal satu booth.');
      if (sizes.length === 0) throw new Error('Pilih minimal satu ukuran.');
      ops.edit('devices.manage', 'printer.save', `Printer ${name} disimpan.`, (draft) => {
        const fields = { name, brand: values.brand as Printer['brand'], boothIds, sizes, paperLeft: parseAmount(String(values.paperLeft)), lowThreshold: parseAmount(String(values.lowThreshold)) };
        const existing = draft.printers.find((entry) => entry.id === printer?.id);
        if (existing) Object.assign(existing, fields);
        else draft.printers.push({ id: ops.store.id(), status: 'ok', error: '', ...fields });
      });
      ops.checkAlerts();
    },
  });
}

/** DNP: the SDK reading. Others: the operator counts after loading a roll or a pack. */
function paperDialog(ops: PageContext['ops'], printer: Printer): void {
  formDialog({
    title: printer.brand === 'dnp' ? `${printer.name}: baca kertas` : `${printer.name}: hitung kertas`,
    description: printer.brand === 'dnp' ? 'Isi angka yang tampil di alat status DNP. Agen native membacanya sendiri dari SDK.' : 'Hitung lembaran setelah memasang kertas. Setiap cetakan mengurangi satu.',
    submitLabel: 'Simpan',
    fields: [{ name: 'count', label: 'Sisa lembar', value: String(printer.paperLeft), type: 'number' }],
    async submit(values) {
      const count = parseAmount(String(values.count));
      ops.edit('devices.manage', 'printer.paper', `${printer.name}: ${count} lembar.`, (draft) => {
        draft.printers.find((entry) => entry.id === printer.id)!.paperLeft = count;
      });
      ops.checkAlerts();
    },
  });
}

function editRule(ops: PageContext['ops'], rule?: RoutingRule): void {
  formDialog({
    title: rule ? 'Ubah aturan peringatan' : 'Tambah aturan peringatan',
    submitLabel: 'Simpan',
    fields: [
      { name: 'branchId', label: 'Cabang', value: rule?.branchId ?? '', options: [{ value: '', label: 'Semua cabang' }, ...ops.visibleBranches().map((branch) => ({ value: branch.id, label: branch.name }))] },
      { name: 'kinds', label: 'Peringatan', value: rule?.kinds ?? ALERT_KINDS, options: ALERT_KINDS.map((kind) => ({ value: kind, label: ALERT_LABELS[kind] })) },
      { name: 'channels', label: 'Saluran', value: rule?.channels ?? ['popup', 'whatsapp'], options: [{ value: 'popup', label: 'Popup di booth' }, { value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' }] },
      { name: 'recipients', label: 'Penerima', value: rule?.recipients ?? ['owner', 'on-duty'], options: [{ value: 'owner', label: 'Pemilik' }, { value: 'on-duty', label: 'Staf bertugas' }, ...ops.state.staff.map((person) => ({ value: person.id, label: person.name }))] },
    ],
    danger: rule ? { label: 'Hapus', run: (close) => { ops.edit('devices.manage', 'rule.delete', 'Aturan peringatan dihapus.', (draft) => { draft.rules = draft.rules.filter((entry) => entry.id !== rule.id); }); close(); } } : undefined,
    async submit(values) {
      const kinds = values.kinds as RoutingRule['kinds'];
      const channels = values.channels as NotifyChannel[];
      if (kinds.length === 0 || channels.length === 0) throw new Error('Pilih minimal satu peringatan dan satu saluran.');
      ops.edit('devices.manage', 'rule.save', 'Aturan peringatan disimpan.', (draft) => {
        const fields = { branchId: String(values.branchId) || null, kinds, channels, recipients: values.recipients as string[] };
        const existing = draft.rules.find((entry) => entry.id === rule?.id);
        if (existing) Object.assign(existing, fields);
        else draft.rules.push({ id: ops.store.id(), ...fields });
      });
    },
  });
}

const WHITE_BALANCE: Record<CameraSettings['whiteBalance'], string> = { auto: 'Otomatis', daylight: 'Siang hari', cloudy: 'Berawan', tungsten: 'Tungsten', fluorescent: 'Neon', flash: 'Flash' };
const PICTURE_STYLE: Record<CameraSettings['pictureStyle'], string> = { standard: 'Standar', portrait: 'Potret', landscape: 'Lanskap', neutral: 'Netral', faithful: 'Asli', monochrome: 'Monokrom' };

function settingsFields(prefix: string, settings: CameraSettings) {
  return [
    { name: `${prefix}iso`, label: 'ISO', value: String(settings.iso), options: ISO_STEPS.map((v) => ({ value: String(v), label: String(v) })) },
    { name: `${prefix}aperture`, label: 'Bukaan', value: String(settings.aperture), options: APERTURE_STEPS.map((v) => ({ value: String(v), label: `f/${v}` })) },
    { name: `${prefix}shutter`, label: 'Kecepatan rana', value: settings.shutter, options: SHUTTER_STEPS.map((v) => ({ value: v, label: v })) },
    { name: `${prefix}whiteBalance`, label: 'White balance', value: settings.whiteBalance, options: (Object.keys(WHITE_BALANCE) as CameraSettings['whiteBalance'][]).map((v) => ({ value: v, label: WHITE_BALANCE[v] })) },
    { name: `${prefix}exposureComp`, label: 'Kompensasi eksposur', value: String(settings.exposureComp), options: [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((v) => ({ value: String(v), label: `${v > 0 ? '+' : ''}${v} EV` })) },
    { name: `${prefix}pictureStyle`, label: 'Gaya gambar', value: settings.pictureStyle, options: (Object.keys(PICTURE_STYLE) as CameraSettings['pictureStyle'][]).map((v) => ({ value: v, label: PICTURE_STYLE[v] })) },
  ];
}

function readSettings(prefix: string, values: Record<string, unknown>): CameraSettings {
  return {
    iso: Number(values[`${prefix}iso`]),
    aperture: Number(values[`${prefix}aperture`]),
    shutter: String(values[`${prefix}shutter`]),
    whiteBalance: values[`${prefix}whiteBalance`] as CameraSettings['whiteBalance'],
    exposureComp: Number(values[`${prefix}exposureComp`]),
    pictureStyle: values[`${prefix}pictureStyle`] as CameraSettings['pictureStyle'],
  };
}

function camerasTab(ops: PageContext['ops'], booths: ReturnType<PageContext['ops']['visibleBooths']>, device: string | null, redraw: () => void): HTMLElement {
  const box = el('div');
  const source = el('div', 'field-row');
  source.append(el('p', 'card-desc', 'Kamera setiap booth: DSLR lewat alamat IP (Canon CCAPI, atau digiCamControl lewat USB), webcam, atau stream IP. Atur memilih koneksi dan kegunaannya di booth. Klik sebuah baris untuk profil pratinjau dan pemotretan.'));
  if (device) source.append(act('Atur kamera perangkat ini', 'btn btn-primary btn-sm', () => cameraSetupDialog(ops, device, redraw), 'camera'));
  source.append(act('Sumber kamera', 'btn btn-outline btn-sm', () => document.dispatchEvent(new Event('vto:pick-camera')), 'tv'));
  box.append(source);
  box.append(
    table(
      [
        { label: 'Booth', cell: (point) => `${point.name}${point.id === device ? ' (perangkat ini)' : ''}` },
        { label: 'Kamera', cell: (point) => cameraLabel(ops.cameraProfile(point.id)) },
        { label: 'Pratinjau', cell: (point) => describeSettings(ops.cameraProfile(point.id).preview) },
        { label: 'Pemotretan', cell: (point) => describeSettings(ops.cameraProfile(point.id).capture) },
        { label: 'Kamera BTS', cell: (point) => (ops.cameraProfile(point.id).secondaryDeviceId ? 'Merekam' : '—') },
        {
          label: '',
          cell: (point) => {
            const setup = act('Atur', 'btn btn-outline btn-sm', () => cameraSetupDialog(ops, point.id, redraw), 'camera');
            // The row opens the profiles; this button opens the connection.
            setup.addEventListener('click', (event) => event.stopPropagation());
            return setup;
          },
        },
      ],
      booths,
      {
        empty: 'Tambah booth di halaman Lokasi.',
        onRow: async (point) => {
          const profile = ops.cameraProfile(point.id);
          const cameras = (await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) ?? [];
          const videoInputs = cameras.filter((camera) => camera.kind === 'videoinput');
          formDialog({
            title: `Kamera ${point.name}`,
            description: 'Pengaturan pratinjau berjalan saat pelanggan mengatur posisi. Pengaturan pemotretan dipakai saat memotret, lalu pratinjau kembali. Semuanya diterapkan ulang setiap kamera menyala.',
            submitLabel: 'Simpan',
            fields: [
              ...settingsFields('p_', profile.preview).map((field) => ({ ...field, label: `Pratinjau · ${field.label}` })),
              ...settingsFields('c_', profile.capture).map((field) => ({ ...field, label: `Pemotretan · ${field.label}` })),
              {
                name: 'secondaryDeviceId',
                label: 'Kamera di balik layar (BTS)',
                value: profile.secondaryDeviceId,
                options: [{ value: '', label: 'Tidak ada' }, ...videoInputs.map((camera, index) => ({ value: camera.deviceId, label: camera.label || `Kamera ${index + 1}` }))],
                hint: 'Kamera kedua yang merekam setiap sesi sebagai klip BTS, untuk CCTV atau konten media sosial.',
              },
            ],
            async submit(values) {
              ops.saveCameraProfile({ ...profile, preview: readSettings('p_', values), capture: readSettings('c_', values), secondaryDeviceId: String(values.secondaryDeviceId) });
            },
          });
        },
      },
    ),
  );
  const camera = ops.camera;
  if (camera instanceof SimulatedEdsdk) {
    const sim = section('Simulator EDSDK', 'Menggantikan bodi Canon di perangkat ini, supaya peringatan kesehatan dan penerapan ulang saat menyala bisa dicoba.');
    const state = camera.state();
    sim.body.append(el('p', 'card-desc', `${state.connected ? 'Nyala' : 'Mati'}${state.battery !== null ? ` · baterai ${state.battery}%` : ''}${state.applied ? ` · profil ${state.applied.profile === 'capture' ? 'pemotretan' : 'pratinjau'} diterapkan` : ''}`));
    sim.actions.append(
      act(state.connected ? 'Matikan' : 'Nyalakan', 'btn btn-outline btn-sm', () => {
        if (state.connected) camera.powerOff();
        else camera.powerOn();
        redraw();
      }),
      act('Baterai 15%', 'btn btn-ghost btn-sm', () => {
        camera.setBattery(15);
        redraw();
      }),
      act('Baterai 100%', 'btn btn-ghost btn-sm', () => {
        camera.setBattery(100);
        notice('Baterai penuh.', 'ok');
        redraw();
      }),
    );
    box.append(sim.root);
  }
  return box;
}

function cameraLabel(profile: CameraProfile): string {
  if (profile.driver === 'dslr' && profile.dslr) return `${profile.dslr.model} · ${profile.dslr.link.host}`;
  return profile.driver === 'edsdk' ? 'Simulator' : 'Webcam atau stream IP';
}

function describeSettings(settings: CameraSettings): string {
  return `ISO ${settings.iso} · f/${settings.aperture} · ${settings.shutter} · ${WHITE_BALANCE[settings.whiteBalance]} · ${settings.exposureComp > 0 ? '+' : ''}${settings.exposureComp} EV`;
}
