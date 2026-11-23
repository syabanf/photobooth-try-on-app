// Fleet: OTA releases with staged rollout and rollback, remote support sessions, and the offline
// queue that syncs sales and sessions to the cloud.

import { formDialog } from '../../../dialogs';
import { compareVersions } from '../../fleet';
import { APP_VERSION } from '../../ops';
import type { PageContext } from '../router';
import { act, badge, confirmAct, dateTime, el, notice, page, section, statRow, table } from '../kit';

export function renderFleet({ ops, redraw }: PageContext): HTMLElement {
  const { state } = ops;
  const root = page('Pembaruan dan bantuan', 'Kirim pembaruan ke sebagian booth dulu, perluas saat lancar, dan kembalikan dengan satu ketukan. Sesi bantuan dan status sinkron juga ada di sini.');
  const device = ops.hooks.devicePointId();
  const booths = ops.visibleBooths();

  // ---------- releases ----------
  const releases = section('Rilis', `Setiap booth menjalankan ${APP_VERSION} sampai sebuah rilis menjangkaunya. Kelompok booth tetap per rilis, jadi memperluas peluncuran hanya menambah booth.`);
  releases.actions.append(
    act('Rilis baru', 'btn btn-primary btn-sm', () =>
      formDialog({
        title: 'Rilis baru',
        submitLabel: 'Siapkan',
        fields: [
          { name: 'version', label: 'Versi', value: '', placeholder: 'Contoh: 0.3.0' },
          { name: 'notes', label: 'Catatan', value: '', type: 'textarea' },
          { name: 'percent', label: 'Booth yang menerima (%)', value: '10', type: 'number', hint: 'Mulai kecil, misalnya 10%, lalu naikkan.' },
        ],
        async submit(values) {
          const version = String(values.version).trim();
          if (!/^\d+(\.\d+){1,3}$/.test(version)) throw new Error('Pakai format versi seperti 0.3.0.');
          if (state.releases.some((release) => release.version === version)) throw new Error(`${version} sudah ada.`);
          const percent = Math.max(0, Math.min(100, Number(values.percent)));
          ops.edit('fleet.manage', 'release.stage', `${version} disiapkan untuk ${percent}% booth.`, (draft) => {
            draft.releases.push({ id: ops.store.id(), version, notes: String(values.notes).trim(), percent, status: 'staged', createdAt: Date.now() });
          });
        },
      }),
    'rocket'),
  );
  releases.body.append(
    table(
      [
        { label: 'Versi', cell: (release) => release.version },
        { label: 'Peluncuran', cell: (release) => (release.status === 'rolled-back' ? badge('Dikembalikan', 'error') : badge(`${release.percent}% booth`, release.percent === 100 ? 'ok' : 'info')) },
        { label: 'Booth di versi ini', className: 'num', cell: (release) => String(booths.filter((point) => ops.targetFor(point.id) === release.version).length) },
        { label: 'Catatan', cell: (release) => release.notes || '—' },
        {
          label: '',
          className: 'actions',
          cell: (release) => {
            const box = el('div', 'row-actions');
            if (release.status !== 'rolled-back') {
              if (release.percent < 100) {
                box.append(act(`Perluas ke ${release.percent < 50 ? 50 : 100}%`, 'btn btn-ghost btn-sm', () =>
                  ops.edit('fleet.manage', 'release.widen', `${release.version} diperluas.`, (draft) => {
                    const target = draft.releases.find((entry) => entry.id === release.id)!;
                    target.percent = target.percent < 50 ? 50 : 100;
                  }),
                ));
              }
              box.append(confirmAct('Kembalikan', 'btn btn-ghost btn-sm btn-danger', `Kembalikan ${release.version}?`, 'Booth di versi ini kembali ke rilis sebelumnya saat pengecekan berikutnya.', () =>
                ops.edit('fleet.manage', 'release.rollback', `${release.version} dikembalikan.`, (draft) => {
                  draft.releases.find((entry) => entry.id === release.id)!.status = 'rolled-back';
                }),
              ));
            }
            return box;
          },
        },
      ],
      [...state.releases].sort((a, b) => compareVersions(b.version, a.version)),
      { empty: 'Belum ada rilis yang disiapkan.' },
    ),
    table(
      [
        { label: 'Booth', cell: (point) => `${point.name}${point.id === device ? ' (perangkat ini)' : ''}` },
        { label: 'Terpasang', cell: (point) => ops.installedVersion(point.id) },
        { label: 'Target', cell: (point) => ops.targetFor(point.id) },
        { label: 'Keadaan', cell: (point) => (ops.installedVersion(point.id) === ops.targetFor(point.id) ? badge('Terbaru', 'ok') : badge('Pembaruan menunggu', 'warn')) },
        {
          label: '',
          className: 'actions',
          cell: (point) =>
            point.id === device && ops.installedVersion(point.id) !== ops.targetFor(point.id)
              ? act('Perbarui sekarang', 'btn btn-secondary btn-sm', () => {
                  const version = ops.applyUpdate(point.id);
                  notice(`Diperbarui ke ${version}. Agen memulai ulang aplikasi di antara sesi.`, 'ok');
                })
              : '',
        },
      ],
      booths,
      { empty: 'Tambah booth di halaman Lokasi.' },
    ),
  );

  // ---------- remote support ----------
  const support = section('Bantuan jarak jauh', 'Booth menampilkan kode, lalu tim bantuan mengetiknya di alat remote mereka untuk terhubung. Operator booth harus mengizinkannya, dan setiap sesi dicatat.');
  support.actions.append(
    act('Minta bantuan untuk booth ini', 'btn btn-outline btn-sm', () => {
      if (!device) throw new Error('Hubungkan perangkat ini ke booth di halaman Lokasi dulu.');
      const code = String(Math.floor(100_000 + Math.random() * 900_000));
      ops.edit('fleet.manage', 'support.request', `Bantuan diminta untuk ${ops.boothName(device)} dengan kode ${code}.`, (draft) => {
        draft.support.unshift({ id: ops.store.id(), boothId: device, code, requestedBy: ops.actor()?.name ?? '', status: 'waiting', startedAt: Date.now(), log: [`${new Date().toLocaleTimeString('id-ID')} diminta`] });
      });
    }, 'support'),
  );
  support.body.append(
    table(
      [
        { label: 'Booth', cell: (entry) => ops.boothName(entry.boothId) },
        { label: 'Kode', cell: (entry) => el('span', 'code', entry.code) },
        { label: 'Status', cell: (entry) => badge(entry.status === 'connected' ? 'Terhubung' : entry.status === 'waiting' ? 'Menunggu bantuan' : 'Selesai', entry.status === 'connected' ? 'warn' : entry.status === 'waiting' ? 'info' : 'muted') },
        { label: 'Mulai', cell: (entry) => dateTime(entry.startedAt) },
        { label: 'Catatan', cell: (entry) => entry.log.join(' · ') },
        {
          label: '',
          className: 'actions',
          cell: (entry) => {
            const box = el('div', 'row-actions');
            const step = (status: 'connected' | 'ended', note: string) =>
              ops.edit('fleet.manage', `support.${status}`, `Sesi bantuan ${entry.code}: ${note}.`, (draft) => {
                const target = draft.support.find((s) => s.id === entry.id)!;
                target.status = status;
                target.log.push(`${new Date().toLocaleTimeString('id-ID')} ${note}`);
                if (status === 'ended') target.endedAt = Date.now();
              });
            if (entry.status === 'waiting') box.append(act('Izinkan koneksi', 'btn btn-ghost btn-sm', () => step('connected', 'operator mengizinkan koneksi')));
            if (entry.status !== 'ended') box.append(act('Akhiri', 'btn btn-ghost btn-sm btn-danger', () => step('ended', 'diakhiri')));
            return box;
          },
        },
      ],
      state.support.slice(0, 50),
      { empty: 'Belum ada sesi bantuan.' },
    ),
  );

  // ---------- sync ----------
  const sync = section('Sinkron cloud', 'Penjualan, sesi, refund, dan shift disimpan dulu di perangkat dan baru dihapus setelah cloud menerimanya, jadi koneksi putus tidak menghilangkan data.');
  const pending = ops.outbox.pending();
  sync.body.append(
    statRow([
      { label: 'Koneksi', value: ops.cloud.online() ? 'Online' : 'Offline', hint: ops.cloud.forcedOffline ? 'Simulasi' : 'Dari browser' },
      { label: 'Data belum terkirim', value: String(pending.length), hint: pending[0]?.lastError ? `Percobaan terakhir: ${pending[0].lastError}` : '' },
      { label: 'Terkirim', value: String(ops.cloud.received()) },
    ]),
  );
  sync.actions.append(
    act(ops.cloud.forcedOffline ? 'Kembali online' : 'Simulasikan offline', 'btn btn-outline btn-sm', async () => {
      ops.cloud.forcedOffline = !ops.cloud.forcedOffline;
      if (!ops.cloud.forcedOffline) await ops.outbox.retryNow();
      redraw();
    }, ops.cloud.forcedOffline ? 'wifi' : 'offline'),
    act('Sinkron sekarang', 'btn btn-ghost btn-sm', async () => {
      const sent = await ops.outbox.retryNow();
      notice(sent ? `${sent} data terkirim.` : ops.cloud.online() ? 'Semua data sudah terkirim.' : 'Masih offline. Data tetap disimpan dan dikirim nanti.', sent ? 'ok' : 'info');
      redraw();
    }, 'refresh'),
  );

  root.body.append(releases.root, support.root, sync.root);
  return root.root;
}
