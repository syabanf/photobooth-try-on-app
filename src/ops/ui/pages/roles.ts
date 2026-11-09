// Roles and permissions: pick a role, switch what it may do, see who holds it, and compare every
// role side by side. The owner role keeps every permission, so the workspace never locks itself out.

import { PERMISSION_GROUPS, PERMISSION_LABELS, PERMISSIONS, ROLES, permissionsOf, roleChanged, type Permission } from '../../access';
import type { Role } from '../../model';
import type { PageContext } from '../router';
import { act, badge, el, notice, page, pills, section, table } from '../kit';

const ROLE_ORDER: Role[] = ['owner', 'admin', 'supervisor', 'cashier', 'operator'];
const view = { role: 'supervisor' as Role };

export function renderRoles({ ops, redraw, nav }: PageContext): HTMLElement {
  const { state } = ops;
  const root = page('Roles and permissions', 'A role decides which pages a person sees and what they may do. Changes apply on every device at once, including menus.');
  root.actions.append(act('Users', 'btn btn-outline', () => nav('staff'), 'users'), act('Sign-in log', 'btn btn-outline', () => nav('signins'), 'key'));

  const holders = (role: Role) => state.staff.filter((person) => person.active && person.role === role);
  const picker = pills(
    ROLE_ORDER.map((role) => ({ value: role, label: `${ROLES[role].label} · ${holders(role).length}` })),
    view.role,
    (role) => {
      view.role = role;
      redraw();
    },
  );

  // ---------- the chosen role ----------
  const role = view.role;
  const granted = new Set(permissionsOf(role));
  const editor = section(ROLES[role].label, role === 'owner' ? 'The owner can always do everything, so someone can always fix the team.' : ROLES[role].detail);
  if (roleChanged(role)) {
    editor.actions.append(badge('Changed', 'info'), act('Back to standard', 'btn btn-ghost btn-sm', () => ops.resetRole(role)));
  }
  const people = el('div', 'role-people');
  const list = holders(role);
  people.append(el('span', 'kicker', list.length ? `${list.length === 1 ? '1 person' : `${list.length} people`} with this role` : 'Nobody has this role yet'));
  for (const person of list) people.append(el('span', 'chip', person.name));
  editor.body.append(people);

  for (const group of PERMISSION_GROUPS) {
    const block = el('div', 'role-group');
    block.append(el('p', 'kicker', group.label));
    for (const permission of group.permissions) {
      const row = el('label', 'field field--switch role-row');
      const box = el('input', 'switch');
      box.type = 'checkbox';
      box.checked = granted.has(permission);
      box.disabled = role === 'owner';
      box.setAttribute('aria-label', `${ROLES[role].label}: ${PERMISSION_LABELS[permission]}`);
      box.addEventListener('change', () => {
        const next = box.checked ? [...granted, permission] : [...granted].filter((entry) => entry !== permission);
        try {
          ops.saveRole(role, next);
          notice(`${ROLES[role].label}: ${box.checked ? 'may' : 'may no longer'} ${PERMISSION_LABELS[permission].toLowerCase()}.`, 'ok');
        } catch (error) {
          box.checked = !box.checked;
          notice((error as Error).message, 'error');
        }
      });
      row.append(el('span', 'field-label', PERMISSION_LABELS[permission]), box);
      block.append(row);
    }
    editor.body.append(block);
  }

  // ---------- compare ----------
  const compare = section('Compare roles', 'Every permission, every role.');
  compare.body.append(
    table(
      [
        { label: 'Permission', cell: (permission: Permission) => PERMISSION_LABELS[permission] },
        ...ROLE_ORDER.map((entry) => ({ label: ROLES[entry].label, className: 'num', cell: (permission: Permission) => (permissionsOf(entry).includes(permission) ? '✓' : '—') })),
      ],
      PERMISSIONS,
    ),
  );

  root.body.append(picker, editor.root, compare.root);
  return root.root;
}
