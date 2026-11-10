// The sign-in log: every sign-in, wrong password, lock and access change in the workspace, with
// the device it came from and who acted on whose sign-in. Owners spot a guessed password here.

import { AUTH_EVENT_LABELS, type AuthEvent, type AuthEventKind } from '../../../account/model';
import { toCsv } from '../../reports';
import type { PageContext } from '../router';
import { act, badge, type BadgeKind, dateTime, downloadText, el, page, pills, statRow, table } from '../kit';

type Show = 'all' | 'signins' | 'problems' | 'changes';

const SHOWS: { value: Show; label: string; kinds: AuthEventKind[] | null }[] = [
  { value: 'all', label: 'All', kinds: null },
  { value: 'signins', label: 'Sign-ins', kinds: ['signin', 'signout', 'screen'] },
  { value: 'problems', label: 'Wrong passwords', kinds: ['failed', 'locked'] },
  { value: 'changes', label: 'Access changes', kinds: ['register', 'claim', 'invite', 'accepted', 'reset', 'password', 'disabled', 'enabled', 'unlocked'] },
];

const KIND_BADGE: Partial<Record<AuthEventKind, BadgeKind>> = { signin: 'ok', failed: 'warn', locked: 'error', disabled: 'error', reset: 'info', invite: 'info' };

const view = { show: 'all' as Show, person: '' };
const WEEK = 7 * 86_400_000;

export function renderSignIns({ ops, redraw, nav }: PageContext): HTMLElement {
  const root = page('Sign-in log', 'Who signed in, from which device, and every wrong password, lock and access change. Kept for the last 1,000 events on this device.');
  root.actions.append(act('Users', 'btn btn-outline', () => nav('staff'), 'users'), act('Roles', 'btn btn-outline', () => nav('roles'), 'shield'));
  const body = el('div', 'ops-body');
  body.append(el('p', 'card-desc', 'Loading the log…'));
  root.body.append(body);

  void ops.accounts?.signInLog().then((events) => body.replaceChildren(...content(events)), (error) => body.replaceChildren(el('p', 'callout', (error as Error).message)));

  function content(events: AuthEvent[]): HTMLElement[] {
    const week = events.filter((event) => Date.now() - event.at < WEEK);
    const kinds = SHOWS.find((entry) => entry.value === view.show)!.kinds;
    const shown = events.filter((event) => (!kinds || kinds.includes(event.kind)) && (!view.person || event.userId === view.person));

    const people = [...new Map(events.map((event) => [event.userId, event.name])).entries()];
    const person = el('select', 'input select');
    person.add(new Option('Everyone', ''));
    for (const [id, name] of people) person.add(new Option(name, id, false, id === view.person));
    person.addEventListener('change', () => {
      view.person = person.value;
      redraw();
    });
    const filters = el('div', 'ops-filters');
    filters.append(
      pills(SHOWS.map(({ value, label }) => ({ value, label })), view.show, (show) => {
        view.show = show;
        redraw();
      }),
      person,
      act('CSV', 'btn btn-outline btn-sm', () =>
        downloadText(toCsv(['When', 'Person', 'Event', 'Device', 'By'], shown.map((event) => [new Date(event.at).toISOString(), event.name, AUTH_EVENT_LABELS[event.kind], event.device, event.byName ?? ''])), 'sign-in-log.csv'),
      'download'),
    );

    return [
      statRow([
        { label: 'Sign-ins', value: String(week.filter((event) => event.kind === 'signin').length), hint: 'Last 7 days' },
        { label: 'People', value: String(new Set(week.filter((event) => event.kind === 'signin').map((event) => event.userId)).size), hint: 'Signed in this week' },
        { label: 'Wrong passwords', value: String(week.filter((event) => event.kind === 'failed').length), hint: 'Last 7 days' },
        { label: 'Locks', value: String(week.filter((event) => event.kind === 'locked').length), hint: 'Last 7 days' },
      ]),
      filters,
      table(
        [
          { label: 'When', cell: (event: AuthEvent) => dateTime(event.at) },
          { label: 'Person', cell: (event: AuthEvent) => event.name },
          { label: 'Event', cell: (event: AuthEvent) => badge(AUTH_EVENT_LABELS[event.kind], KIND_BADGE[event.kind] ?? 'muted') },
          { label: 'Device', cell: (event: AuthEvent) => event.device },
          { label: 'By', cell: (event: AuthEvent) => event.byName ?? '—' },
        ],
        shown,
        { empty: 'Nothing matches. Pick All or Everyone.' },
      ),
    ];
  }
  return root.root;
}
