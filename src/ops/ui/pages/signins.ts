// The sign-in log: every sign-in, wrong password, lock and access change in the workspace, with
// the device it came from and who acted on whose sign-in. Owners spot a guessed password here.

import { AUTH_EVENT_LABELS, type AuthEvent, type AuthEventKind } from '../../../account/model';
import { toCsv } from '../../reports';
import type { PageContext } from '../router';
import { act, badge, type BadgeKind, dateTime, downloadText, el, page, pills, statRow, table } from '../kit';

type Show = 'all' | 'signins' | 'problems' | 'changes';

const SHOWS: { value: Show; label: string; kinds: AuthEventKind[] | null }[] = [
  { value: 'all', label: 'Semua', kinds: null },
  { value: 'signins', label: 'Masuk', kinds: ['signin', 'signout', 'screen'] },
  { value: 'problems', label: 'Kata sandi salah', kinds: ['failed', 'locked'] },
  { value: 'changes', label: 'Perubahan akses', kinds: ['register', 'claim', 'invite', 'accepted', 'reset', 'password', 'disabled', 'enabled', 'unlocked'] },
];

const KIND_BADGE: Partial<Record<AuthEventKind, BadgeKind>> = { signin: 'ok', failed: 'warn', locked: 'error', disabled: 'error', reset: 'info', invite: 'info' };

const view = { show: 'all' as Show, person: '' };
const WEEK = 7 * 86_400_000;

export function renderSignIns({ ops, redraw, nav }: PageContext): HTMLElement {
  const root = page('Log masuk', 'Siapa yang masuk, dari perangkat mana, serta setiap kata sandi salah, penguncian, dan perubahan akses. Menyimpan 1.000 kejadian terakhir di perangkat ini.');
  root.actions.append(act('Pengguna', 'btn btn-outline', () => nav('staff'), 'users'), act('Peran', 'btn btn-outline', () => nav('roles'), 'shield'));
  const body = el('div', 'ops-body');
  body.append(el('p', 'card-desc', 'Memuat log…'));
  root.body.append(body);

  void ops.accounts?.signInLog().then((events) => body.replaceChildren(...content(events)), (error) => body.replaceChildren(el('p', 'callout', (error as Error).message)));

  function content(events: AuthEvent[]): HTMLElement[] {
    const week = events.filter((event) => Date.now() - event.at < WEEK);
    const kinds = SHOWS.find((entry) => entry.value === view.show)!.kinds;
    const shown = events.filter((event) => (!kinds || kinds.includes(event.kind)) && (!view.person || event.userId === view.person));

    const people = [...new Map(events.map((event) => [event.userId, event.name])).entries()];
    const person = el('select', 'input select');
    person.add(new Option('Semua orang', ''));
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
        downloadText(toCsv(['Waktu', 'Orang', 'Kejadian', 'Perangkat', 'Oleh'], shown.map((event) => [new Date(event.at).toISOString(), event.name, AUTH_EVENT_LABELS[event.kind], event.device, event.byName ?? ''])), 'sign-in-log.csv'),
      'download'),
    );

    return [
      statRow([
        { label: 'Masuk', value: String(week.filter((event) => event.kind === 'signin').length), hint: '7 hari terakhir' },
        { label: 'Orang', value: String(new Set(week.filter((event) => event.kind === 'signin').map((event) => event.userId)).size), hint: 'Masuk minggu ini' },
        { label: 'Kata sandi salah', value: String(week.filter((event) => event.kind === 'failed').length), hint: '7 hari terakhir' },
        { label: 'Penguncian', value: String(week.filter((event) => event.kind === 'locked').length), hint: '7 hari terakhir' },
      ]),
      filters,
      table(
        [
          { label: 'Waktu', cell: (event: AuthEvent) => dateTime(event.at) },
          { label: 'Orang', cell: (event: AuthEvent) => event.name },
          { label: 'Kejadian', cell: (event: AuthEvent) => badge(AUTH_EVENT_LABELS[event.kind], KIND_BADGE[event.kind] ?? 'muted') },
          { label: 'Perangkat', cell: (event: AuthEvent) => event.device },
          { label: 'Oleh', cell: (event: AuthEvent) => event.byName ?? '—' },
        ],
        shown,
        { empty: 'Tidak ada yang cocok. Pilih Semua atau Semua orang.' },
      ),
    ];
  }
  return root.root;
}
