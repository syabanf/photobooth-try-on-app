// Users (IAM): who works where, which role they hold, who signs in and how, PINs for shared
// devices, and who is on duty. Roles and the sign-in log have pages of their own.

import { formDialog, openDialog } from '../../../dialogs';
import type { Invite, Member } from '../../../account/model';
import { ROLES } from '../../access';
import type { Role, Staff } from '../../model';
import type { PageContext } from '../router';
import { act, badge, type BadgeKind, dateTime, el, notice, page, qrCanvas, statRow, table } from '../kit';
import { uuid } from '../../../uuid';

type Ops = PageContext['ops'];

/** What the sign-in column says about a person, and the one action it offers. */
function signInState(person: Staff, member: Member | null): { label: string; kind: BadgeKind; detail: string } {
  const now = Date.now();
  if (!member) return { label: 'Belum bisa masuk', kind: 'muted', detail: person.email ? 'Siap diundang' : 'Tambah email untuk mengundang' };
  if (member.status === 'disabled') return { label: 'Mati', kind: 'muted', detail: 'Tidak bisa masuk' };
  if (member.status === 'invited') {
    const expired = (member.inviteExpiresAt ?? 0) <= now;
    return { label: expired ? 'Kode kedaluwarsa' : 'Kode terkirim', kind: 'warn', detail: expired ? 'Kirim kode baru' : `Sampai ${dateTime(member.inviteExpiresAt ?? 0)}` };
  }
  if (member.lockedUntil > now) return { label: 'Terkunci', kind: 'error', detail: `Terlalu sering salah kata sandi, sampai ${dateTime(member.lockedUntil)}` };
  return { label: 'Aktif', kind: 'ok', detail: member.lastSignInAt ? `Terakhir masuk ${dateTime(member.lastSignInAt)}` : 'Belum pernah masuk' };
}

export function renderStaff({ ops, nav }: PageContext): HTMLElement {
  const { state } = ops;
  const actor = ops.actor();
  const root = page('Pengguna', 'Setiap orang punya peran dan cabang tempat bekerja, dan masuk dengan email dan kata sandinya sendiri. PIN dipakai untuk mengambil alih perangkat booth bersama.');
  root.actions.append(
    act('Tambah orang', 'btn btn-primary', () => editStaff(ops), 'plus'),
    act('Ganti pengguna', 'btn btn-outline', () => switchDialog(ops), 'users'),
    act('Peran', 'btn btn-ghost', () => nav('roles'), 'shield'),
    act('Log masuk', 'btn btn-ghost', () => nav('signins'), 'key'),
  );

  const members = state.staff.map((person) => ops.member(person.id));
  const now = Date.now();
  root.body.append(
    statRow([
      { label: 'Orang', value: String(state.staff.filter((person) => person.active).length), hint: `${state.staff.filter((person) => !person.active).length} sudah keluar` },
      { label: 'Bisa masuk', value: String(members.filter((member) => member?.status === 'active').length) },
      { label: 'Kode menunggu', value: String(members.filter((member) => member?.status === 'invited' && (member.inviteExpiresAt ?? 0) > now).length) },
      { label: 'Terkunci atau mati', value: String(members.filter((member) => member && (member.status === 'disabled' || member.lockedUntil > now)).length) },
    ]),
    el('p', 'card-desc', `Memakai perangkat ini: ${actor?.name ?? 'tidak ada'} (${actor ? ROLES[actor.role].label : 'tanpa peran'}).`),
    table(
      [
        {
          label: 'Nama',
          cell: (person) => {
            const cell = el('div', 'rank-text');
            cell.append(el('span', 'rank-name', person.name), el('span', 'rank-meta', person.email || 'Tanpa email'));
            return cell;
          },
        },
        { label: 'Peran', cell: (person) => ROLES[person.role].label },
        { label: 'Cabang', cell: (person) => (person.branchIds.length ? person.branchIds.map((id) => ops.branchName(id)).join(', ') : 'Semua') },
        {
          label: 'Akses masuk',
          cell: (person) => {
            const view = signInState(person, ops.member(person.id));
            const cell = el('div', 'rank-text');
            cell.append(badge(view.label, view.kind), el('span', 'rank-meta', view.detail));
            return cell;
          },
        },
        {
          label: '',
          cell: (person) => (person.active ? act(ops.member(person.id) ? 'Akses' : 'Undang', 'btn btn-outline btn-sm', () => accessDialog(ops, person), 'key') : el('span')),
        },
        { label: 'PIN', cell: (person) => (person.pinHash ? badge('Ada', 'ok') : badge('Belum ada', 'muted')) },
        {
          label: 'Bertugas',
          cell: (person) =>
            act(person.onDuty ? 'Bertugas' : 'Tidak bertugas', person.onDuty ? 'btn btn-secondary btn-sm' : 'btn btn-ghost btn-sm', () =>
              ops.edit('staff.manage', 'staff.duty', `${person.name} ${person.onDuty ? 'selesai bertugas' : 'mulai bertugas'}.`, (draft) => {
                const target = draft.staff.find((entry) => entry.id === person.id)!;
                target.onDuty = !target.onDuty;
              }),
            ),
        },
        { label: 'Status', cell: (person) => badge(person.active ? 'Aktif' : 'Keluar', person.active ? 'ok' : 'muted') },
      ],
      state.staff,
      { onRow: (person) => editStaff(ops, person) },
    ),
  );

  return root.root;
}

function editStaff(ops: Ops, person?: Staff): void {
  formDialog({
    title: person ? `Ubah ${person.name}` : 'Tambah orang',
    description: person ? undefined : 'Dengan email, orang ini menerima kode untuk membuat kata sandinya sendiri.',
    submitLabel: 'Simpan',
    fields: [
      { name: 'name', label: 'Nama', value: person?.name ?? '' },
      { name: 'email', label: 'Email', value: person?.email ?? '', type: 'email', hint: 'Dipakai untuk masuk.' },
      { name: 'role', label: 'Peran', value: person?.role ?? 'cashier', options: (Object.keys(ROLES) as Role[]).map((role) => ({ value: role, label: `${ROLES[role].label}: ${ROLES[role].detail}` })) },
      { name: 'branchIds', label: 'Cabang', value: person?.branchIds ?? [], options: ops.sites.locations.map((branch) => ({ value: branch.id, label: branch.name })), hint: 'Tanpa centang berarti semua cabang.' },
      { name: 'pin', label: person?.pinHash ? 'PIN baru (kosongkan untuk tetap)' : 'PIN', value: '', type: 'password', hint: '4 sampai 8 angka. Untuk mengambil alih perangkat bersama dan, bagi supervisor, menyetujui refund.' },
      { name: 'phone', label: 'WhatsApp', value: person?.phone ?? '', type: 'tel', hint: 'Untuk peringatan.' },
      { name: 'onDuty', label: 'Bertugas', value: person?.onDuty ?? true },
      { name: 'active', label: 'Aktif', value: person?.active ?? true, hint: 'Matikan saat seseorang keluar. Riwayatnya tetap ada dan aksesnya berhenti.' },
      ...(person ? [] : [{ name: 'invite', label: 'Kirim kode masuk sekarang', value: true }]),
    ],
    async submit(values) {
      const id = await ops.saveStaff(
        {
          id: person?.id,
          name: String(values.name),
          role: values.role as Role,
          branchIds: values.branchIds as string[],
          phone: String(values.phone).trim(),
          email: String(values.email).trim(),
          onDuty: values.onDuty as boolean,
          active: values.active as boolean,
        },
        String(values.pin),
      );
      if (values.invite && String(values.email).trim()) {
        const invite = await ops.inviteMember(id, uuid());
        setTimeout(() => codeDialog(invite));
      }
    },
  });
}

/** One person's sign-in: send or resend a code, reset the password, unlock, or turn it off. */
function accessDialog(ops: Ops, person: Staff): void {
  const member = ops.member(person.id);
  const view = signInState(person, member);
  // One key per dialog: a double tap on Send code hands out one code.
  const key = uuid();
  const facts = el('dl', 'facts');
  for (const [term, value] of [
    ['Email', person.email || 'Belum ada'],
    ['Peran', ROLES[person.role].label],
    ['Akses masuk', `${view.label} · ${view.detail}`],
    ['Bergabung', member ? dateTime(member.createdAt) : 'Belum diundang'],
  ]) {
    facts.append(el('dt', '', term), el('dd', '', value));
  }
  const actions = el('div', 'access-actions');
  /** An access action: a code opens the code dialog, anything else confirms with `done`. */
  const run = (label: string, className: string, work: () => Promise<Invite | void>, done = '', iconName?: 'key' | 'lock' | 'shield' | 'send') =>
    act(label, className, async () => {
      const invite = await work();
      handle.close();
      if (invite) setTimeout(() => codeDialog(invite));
      else notice(done, 'ok');
    }, iconName);

  if (!person.email) {
    actions.append(act('Tambah email', 'btn btn-primary btn-block', () => {
      handle.close();
      editStaff(ops, person);
    }));
  } else if (!member || member.status === 'invited') {
    actions.append(run(member ? 'Lihat atau perbarui kode' : 'Kirim kode masuk', 'btn btn-primary btn-block', () => ops.inviteMember(person.id, key), '', 'send'));
  } else if (member.status === 'disabled') {
    actions.append(run('Aktifkan akses masuk', 'btn btn-primary btn-block', () => ops.setMemberAccess(person.id, true), `${person.name} bisa masuk lagi.`, 'shield'));
    actions.append(run('Kirim kode baru', 'btn btn-outline btn-block', () => ops.resetMember(person.id), '', 'key'));
  } else {
    if (member.lockedUntil > Date.now()) actions.append(run('Buka kunci sekarang', 'btn btn-primary btn-block', () => ops.setMemberAccess(person.id, true), `${person.name} bisa mencoba lagi sekarang.`, 'lock'));
    actions.append(run('Reset kata sandi', 'btn btn-outline btn-block', () => ops.resetMember(person.id), '', 'key'));
    actions.append(run('Matikan akses masuk', 'btn btn-ghost btn-danger btn-block', () => ops.setMemberAccess(person.id, false), `${person.name} tidak bisa masuk lagi.`));
  }
  const close = el('button', 'btn btn-outline', 'Tutup');
  close.type = 'button';
  close.dataset.close = '';
  const handle = openDialog({ title: person.name, description: 'Cara orang ini masuk.', body: [facts, actions], footer: [close] });
}

/** The code to hand over in person or by WhatsApp, with the link and a QR that opens it. */
function codeDialog(invite: Invite): void {
  const link = `${location.origin}${location.pathname}#invite=${invite.code}`;
  const body = el('div', 'ticket-card');
  body.append(el('p', 'kicker', 'Kode masuk'), el('p', 'invite-code', invite.code), qrCanvas(link, 180), el('p', 'card-desc', `${invite.member.name} memasukkan kode ini di layar masuk lewat "Atur kata sandi", atau memindai QR. Kode hanya berlaku sekali, sampai ${dateTime(invite.expiresAt)}.`));
  const copy = act('Salin tautan', 'btn btn-outline', async () => {
    await navigator.clipboard.writeText(link);
    notice('Tautan disalin.', 'ok');
  }, 'copy');
  const done = el('button', 'btn btn-primary', 'Selesai');
  done.type = 'button';
  done.dataset.close = '';
  openDialog({ title: `Kode untuk ${invite.member.name}`, description: 'Di versi ini kode hanya berlaku di browser ini. Server produksi membuatnya berlaku di perangkat mana pun.', body: [body], footer: [copy, done] });
}

function switchDialog(ops: Ops): void {
  const people = ops.state.staff.filter((person) => person.active);
  formDialog({
    title: 'Ganti pengguna',
    description: 'Penjualan, refund, dan shift berikutnya di perangkat ini dicatat atas nama orang ini.',
    submitLabel: 'Ganti',
    fields: [
      { name: 'id', label: 'Orang', value: ops.actor()?.id ?? people[0]?.id ?? '', options: people.map((person) => ({ value: person.id, label: `${person.name} · ${ROLES[person.role].label}` })) },
      { name: 'pin', label: 'PIN', value: '', type: 'password' },
    ],
    async submit(values) {
      await ops.switchActor(String(values.id), String(values.pin));
    },
  });
}
