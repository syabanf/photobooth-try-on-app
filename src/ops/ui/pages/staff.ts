// Staff and roles: who works where, what each role may do, PINs, who is on duty, and switching
// the person using this device.

import { formDialog } from '../../../dialogs';
import { ROLES, type Permission } from '../../access';
import type { Role, Staff } from '../../model';
import type { PageContext } from '../router';
import { act, badge, el, page, section, table } from '../kit';

const PERMISSION_LABELS: Record<Permission, string> = {
  'pos.sell': 'Sell at the till',
  'pos.refund': 'Approve refunds',
  'pos.discount': 'Give discounts',
  'shift.run': 'Open and close shifts',
  'queue.run': 'Run the queue',
  'booth.run': 'Run booth sessions',
  'history.view': 'See transactions',
  'reports.view': 'See reports',
  'vouchers.manage': 'Manage vouchers',
  'frames.manage': 'Manage frames',
  'branding.manage': 'Manage branding and ads',
  'devices.manage': 'Manage devices and alerts',
  'staff.manage': 'Manage staff',
  'settings.manage': 'Change prices and settings',
  'fleet.manage': 'Updates and remote support',
};

export function renderStaff({ ops }: PageContext): HTMLElement {
  const { state } = ops;
  const actor = ops.actor();
  const root = page('Staff', 'Each person gets a role and the branches they work at; they only see those branches. Supervisors approve refunds with their PIN.');
  root.actions.append(act('Add person', 'btn btn-primary', () => editStaff(ops), 'plus'), act('Switch user', 'btn btn-outline', () => switchDialog(ops), 'users'));
  root.body.append(
    el('p', 'card-desc', `Using this device: ${actor?.name ?? 'nobody'} (${actor ? ROLES[actor.role].label : '—'}).`),
    table(
      [
        { label: 'Name', cell: (person) => person.name },
        { label: 'Role', cell: (person) => ROLES[person.role].label },
        { label: 'Branches', cell: (person) => (person.branchIds.length ? person.branchIds.map((id) => ops.branchName(id)).join(', ') : 'All') },
        { label: 'PIN', cell: (person) => (person.pinHash ? badge('Set', 'ok') : badge('None', 'muted')) },
        { label: 'Contact', cell: (person) => [person.phone, person.email].filter(Boolean).join(' · ') || '—' },
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

  const matrix = section('What each role can do');
  const roles = Object.keys(ROLES) as Role[];
  matrix.body.append(
    table(
      [{ label: 'Permission', cell: (permission: Permission) => PERMISSION_LABELS[permission] }, ...roles.map((role) => ({ label: ROLES[role].label, className: 'num', cell: (permission: Permission) => (ROLES[role].can.includes(permission) ? '✓' : '—') }))],
      Object.keys(PERMISSION_LABELS) as Permission[],
    ),
  );
  root.body.append(matrix.root);
  return root.root;
}

function editStaff(ops: PageContext['ops'], person?: Staff): void {
  formDialog({
    title: person ? `Edit ${person.name}` : 'Add person',
    submitLabel: 'Save',
    fields: [
      { name: 'name', label: 'Name', value: person?.name ?? '' },
      { name: 'role', label: 'Role', value: person?.role ?? 'cashier', options: (Object.keys(ROLES) as Role[]).map((role) => ({ value: role, label: `${ROLES[role].label}: ${ROLES[role].detail}` })) },
      { name: 'branchIds', label: 'Branches', value: person?.branchIds ?? [], options: ops.sites.locations.map((branch) => ({ value: branch.id, label: branch.name })), hint: 'None ticked means every branch.' },
      { name: 'pin', label: person?.pinHash ? 'New PIN (leave empty to keep)' : 'PIN', value: '', type: 'password', hint: '4 to 8 digits. Needed to switch to this person and, for supervisors, to approve refunds.' },
      { name: 'phone', label: 'WhatsApp', value: person?.phone ?? '', type: 'tel', hint: 'For alerts.' },
      { name: 'email', label: 'Email', value: person?.email ?? '', type: 'email' },
      { name: 'onDuty', label: 'On duty', value: person?.onDuty ?? true },
      { name: 'active', label: 'Active', value: person?.active ?? true, hint: 'Turn off when someone leaves; their history stays.' },
    ],
    async submit(values) {
      await ops.saveStaff(
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
    },
  });
}

function switchDialog(ops: PageContext['ops']): void {
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
