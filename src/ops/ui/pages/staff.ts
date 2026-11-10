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
  if (!member) return { label: 'No sign-in', kind: 'muted', detail: person.email ? 'Ready to invite' : 'Add an email to invite' };
  if (member.status === 'disabled') return { label: 'Off', kind: 'muted', detail: 'Cannot sign in' };
  if (member.status === 'invited') {
    const expired = (member.inviteExpiresAt ?? 0) <= now;
    return { label: expired ? 'Code expired' : 'Code sent', kind: 'warn', detail: expired ? 'Send a new code' : `Until ${dateTime(member.inviteExpiresAt ?? 0)}` };
  }
  if (member.lockedUntil > now) return { label: 'Locked', kind: 'error', detail: `Too many wrong passwords, until ${dateTime(member.lockedUntil)}` };
  return { label: 'Active', kind: 'ok', detail: member.lastSignInAt ? `Last in ${dateTime(member.lastSignInAt)}` : 'Not signed in yet' };
}

export function renderStaff({ ops, nav }: PageContext): HTMLElement {
  const { state } = ops;
  const actor = ops.actor();
  const root = page('Users', 'Each person gets a role and the branches they work at, and signs in with their own email and password. A PIN lets someone take over a shared booth device.');
  root.actions.append(
    act('Add person', 'btn btn-primary', () => editStaff(ops), 'plus'),
    act('Switch user', 'btn btn-outline', () => switchDialog(ops), 'users'),
    act('Roles', 'btn btn-ghost', () => nav('roles'), 'shield'),
    act('Sign-in log', 'btn btn-ghost', () => nav('signins'), 'key'),
  );

  const members = state.staff.map((person) => ops.member(person.id));
  const now = Date.now();
  root.body.append(
    statRow([
      { label: 'People', value: String(state.staff.filter((person) => person.active).length), hint: `${state.staff.filter((person) => !person.active).length} left` },
      { label: 'Signing in', value: String(members.filter((member) => member?.status === 'active').length) },
      { label: 'Codes waiting', value: String(members.filter((member) => member?.status === 'invited' && (member.inviteExpiresAt ?? 0) > now).length) },
      { label: 'Locked or off', value: String(members.filter((member) => member && (member.status === 'disabled' || member.lockedUntil > now)).length) },
    ]),
    el('p', 'card-desc', `Using this device: ${actor?.name ?? 'nobody'} (${actor ? ROLES[actor.role].label : 'no role'}).`),
    table(
      [
        {
          label: 'Name',
          cell: (person) => {
            const cell = el('div', 'rank-text');
            cell.append(el('span', 'rank-name', person.name), el('span', 'rank-meta', person.email || 'No email'));
            return cell;
          },
        },
        { label: 'Role', cell: (person) => ROLES[person.role].label },
        { label: 'Branches', cell: (person) => (person.branchIds.length ? person.branchIds.map((id) => ops.branchName(id)).join(', ') : 'All') },
        {
          label: 'Sign-in',
          cell: (person) => {
            const view = signInState(person, ops.member(person.id));
            const cell = el('div', 'rank-text');
            cell.append(badge(view.label, view.kind), el('span', 'rank-meta', view.detail));
            return cell;
          },
        },
        {
          label: '',
          cell: (person) => (person.active ? act(ops.member(person.id) ? 'Access' : 'Invite', 'btn btn-outline btn-sm', () => accessDialog(ops, person), 'key') : el('span')),
        },
        { label: 'PIN', cell: (person) => (person.pinHash ? badge('Set', 'ok') : badge('None', 'muted')) },
        {
          label: 'On duty',
          cell: (person) =>
            act(person.onDuty ? 'On duty' : 'Off', person.onDuty ? 'btn btn-secondary btn-sm' : 'btn btn-ghost btn-sm', () =>
              ops.edit('staff.manage', 'staff.duty', `${person.name} is ${person.onDuty ? 'off' : 'on'} duty.`, (draft) => {
                const target = draft.staff.find((entry) => entry.id === person.id)!;
                target.onDuty = !target.onDuty;
              }),
            ),
        },
        { label: 'Status', cell: (person) => badge(person.active ? 'Active' : 'Left', person.active ? 'ok' : 'muted') },
      ],
      state.staff,
      { onRow: (person) => editStaff(ops, person) },
    ),
  );

  return root.root;
}

function editStaff(ops: Ops, person?: Staff): void {
  formDialog({
    title: person ? `Edit ${person.name}` : 'Add person',
    description: person ? undefined : 'With an email, they get a code to set their own password.',
    submitLabel: 'Save',
    fields: [
      { name: 'name', label: 'Name', value: person?.name ?? '' },
      { name: 'email', label: 'Email', value: person?.email ?? '', type: 'email', hint: 'They sign in with it.' },
      { name: 'role', label: 'Role', value: person?.role ?? 'cashier', options: (Object.keys(ROLES) as Role[]).map((role) => ({ value: role, label: `${ROLES[role].label}: ${ROLES[role].detail}` })) },
      { name: 'branchIds', label: 'Branches', value: person?.branchIds ?? [], options: ops.sites.locations.map((branch) => ({ value: branch.id, label: branch.name })), hint: 'None ticked means every branch.' },
      { name: 'pin', label: person?.pinHash ? 'New PIN (leave empty to keep)' : 'PIN', value: '', type: 'password', hint: '4 to 8 digits. Takes over a shared device and, for supervisors, approves refunds.' },
      { name: 'phone', label: 'WhatsApp', value: person?.phone ?? '', type: 'tel', hint: 'For alerts.' },
      { name: 'onDuty', label: 'On duty', value: person?.onDuty ?? true },
      { name: 'active', label: 'Active', value: person?.active ?? true, hint: 'Turn off when someone leaves. Their history stays and their sign-in stops.' },
      ...(person ? [] : [{ name: 'invite', label: 'Send a sign-in code now', value: true }]),
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
    ['Email', person.email || 'None yet'],
    ['Role', ROLES[person.role].label],
    ['Sign-in', `${view.label} · ${view.detail}`],
    ['Joined', member ? dateTime(member.createdAt) : 'Not invited'],
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
    actions.append(act('Add an email', 'btn btn-primary btn-block', () => {
      handle.close();
      editStaff(ops, person);
    }));
  } else if (!member || member.status === 'invited') {
    actions.append(run(member ? 'Show or renew the code' : 'Send a sign-in code', 'btn btn-primary btn-block', () => ops.inviteMember(person.id, key), '', 'send'));
  } else if (member.status === 'disabled') {
    actions.append(run('Turn sign-in on', 'btn btn-primary btn-block', () => ops.setMemberAccess(person.id, true), `${person.name} can sign in again.`, 'shield'));
    actions.append(run('Send a new code', 'btn btn-outline btn-block', () => ops.resetMember(person.id), '', 'key'));
  } else {
    if (member.lockedUntil > Date.now()) actions.append(run('Unlock now', 'btn btn-primary btn-block', () => ops.setMemberAccess(person.id, true), `${person.name} can try again now.`, 'lock'));
    actions.append(run('Reset password', 'btn btn-outline btn-block', () => ops.resetMember(person.id), '', 'key'));
    actions.append(run('Turn sign-in off', 'btn btn-ghost btn-danger btn-block', () => ops.setMemberAccess(person.id, false), `${person.name} can no longer sign in.`));
  }
  const close = el('button', 'btn btn-outline', 'Close');
  close.type = 'button';
  close.dataset.close = '';
  const handle = openDialog({ title: person.name, description: 'How this person signs in.', body: [facts, actions], footer: [close] });
}

/** The code to hand over in person or by WhatsApp, with the link and a QR that opens it. */
function codeDialog(invite: Invite): void {
  const link = `${location.origin}${location.pathname}#invite=${invite.code}`;
  const body = el('div', 'ticket-card');
  body.append(el('p', 'kicker', 'Sign-in code'), el('p', 'invite-code', invite.code), qrCanvas(link, 180), el('p', 'card-desc', `${invite.member.name} enters this code on the sign-in screen under "Set your password", or scans the QR. It works once, until ${dateTime(invite.expiresAt)}.`));
  const copy = act('Copy link', 'btn btn-outline', async () => {
    await navigator.clipboard.writeText(link);
    notice('Link copied.', 'ok');
  }, 'copy');
  const done = el('button', 'btn btn-primary', 'Done');
  done.type = 'button';
  done.dataset.close = '';
  openDialog({ title: `Code for ${invite.member.name}`, description: 'In this build the code works in this browser. The production server makes it work on any device.', body: [body], footer: [copy, done] });
}

function switchDialog(ops: Ops): void {
  const people = ops.state.staff.filter((person) => person.active);
  formDialog({
    title: 'Switch user',
    description: 'The next sales, refunds and shifts on this device are logged under this person.',
    submitLabel: 'Switch',
    fields: [
      { name: 'id', label: 'Person', value: ops.actor()?.id ?? people[0]?.id ?? '', options: people.map((person) => ({ value: person.id, label: `${person.name} · ${ROLES[person.role].label}` })) },
      { name: 'pin', label: 'PIN', value: '', type: 'password' },
    ],
    async submit(values) {
      await ops.switchActor(String(values.id), String(values.pin));
    },
  });
}
