// Activity history: every change the workspace logged, by day, with who did it, the area and the
// amount. Filters narrow it to a person, an area, a branch, dates or words, and CSV exports it.

import { seesBranch } from '../../access';
import { AREA_LABELS, areaOf, byDay, countByArea, filterHistory, type Area } from '../../history';
import type { ActivityEntry } from '../../model';
import { toCsv } from '../../reports';
import { localTimeZone, zonedTime } from '../../time';
import { ACTIVITY_LIMIT } from '../../store';
import type { PageContext } from '../router';
import { act, badge, downloadText, el, money, page, statRow } from '../kit';

const PAGE = 150;
const view = { from: '', to: '', staffId: '', area: '' as Area | '', branchId: '', query: '', shown: PAGE };

const longDay = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDay = (date: string) => (date ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'any day');
const clock = (time: number) => new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function renderHistory({ ops, redraw }: PageContext): HTMLElement {
  const { state } = ops;
  const timeZone = localTimeZone();
  if (!view.from) {
    view.to = zonedTime(Date.now(), timeZone).date;
    view.from = zonedTime(Date.now() - 6 * 86_400_000, timeZone).date;
  }
  const actor = ops.actor();
  // Branch-bound staff see their branches' entries and the ones tied to no branch.
  const visible = state.activity.filter((entry) => entry.branchId === null || seesBranch(actor, entry.branchId));
  const matches = filterHistory(visible, { ...view, timeZone });
  const nameOf = (staffId: string | null) => (staffId ? (state.staff.find((person) => person.id === staffId)?.name ?? 'Former staff') : 'System');

  const root = page('Activity history', `Everything that changed: sales, refunds, payments, the queue, faces, sign-ins, prices and devices. This device keeps the newest ${ACTIVITY_LIMIT.toLocaleString()} entries; the cloud keeps the rest once synced.`);

  // ---------- filters ----------
  const filters = el('div', 'ops-filters');
  const input = (type: string, value: string, label: string, apply: (value: string) => void) => {
    const element = el('input', 'input');
    element.type = type;
    element.value = value;
    element.setAttribute('aria-label', label);
    element.addEventListener('change', () => {
      apply(element.value);
      view.shown = PAGE;
      redraw();
    });
    return element;
  };
  const select = (label: string, options: [string, string][], value: string, apply: (value: string) => void) => {
    const element = el('select', 'input select');
    element.setAttribute('aria-label', label);
    for (const [optionValue, optionLabel] of options) element.add(new Option(optionLabel, optionValue, false, optionValue === value));
    element.addEventListener('change', () => {
      apply(element.value);
      view.shown = PAGE;
      redraw();
    });
    return element;
  };
  const areaCounts = countByArea(filterHistory(visible, { ...view, area: '', timeZone }));
  const dates = el('div', 'date-range');
  dates.append(input('date', view.from, 'From', (value) => (view.from = value)), input('date', view.to, 'To', (value) => (view.to = value)));
  filters.append(
    dates,
    select('Person', [['', 'Everyone'], ...state.staff.map((person): [string, string] => [person.id, person.name]), ['system', 'System and alerts']], view.staffId, (value) => (view.staffId = value)),
    select('Area', [['', 'Every area'], ...(Object.keys(AREA_LABELS) as Area[]).map((area): [string, string] => [area, `${AREA_LABELS[area]}${areaCounts[area] ? ` · ${areaCounts[area]}` : ''}`])], view.area, (value) => (view.area = value as Area | '')),
    select('Branch', [['', 'All branches'], ...ops.visibleBranches().map((branch): [string, string] => [branch.id, branch.name])], view.branchId, (value) => (view.branchId = value)),
    input('search', view.query, 'Search the history', (value) => (view.query = value)),
    act('CSV', 'btn btn-outline btn-sm', () =>
      downloadText(
        toCsv(['When', 'Person', 'Area', 'Branch', 'What happened', 'Amount'], matches.map((entry) => [new Date(entry.at).toISOString(), nameOf(entry.staffId), AREA_LABELS[areaOf(entry.kind)], entry.branchId ? ops.branchName(entry.branchId) : '', entry.message, entry.amount ?? ''])),
        `activity-${view.from}-to-${view.to}.csv`,
      ),
    'download'),
  );
  filters.querySelector('input[type=search]')!.setAttribute('placeholder', 'Words, an order number, a name');

  // ---------- summary ----------
  const people = new Set(matches.map((entry) => entry.staffId).filter(Boolean));
  const moneyIn = matches.filter((entry) => areaOf(entry.kind) === 'sales' && entry.kind !== 'order.refund').reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
  const stats = statRow([
    { label: 'Entries', value: matches.length.toLocaleString(), hint: `${shortDay(view.from)} to ${shortDay(view.to)}` },
    { label: 'People', value: String(people.size), hint: 'Who made a change' },
    { label: 'Money logged', value: money(moneyIn), hint: 'On sales entries' },
    { label: 'Alerts', value: String(matches.filter((entry) => entry.kind.startsWith('alert.')).length), hint: 'Raised by devices' },
  ]);

  // ---------- the days ----------
  const list = el('div', 'history-days');
  for (const day of byDay(matches.slice(0, view.shown), timeZone)) {
    const block = el('section', 'history-day');
    block.append(el('h3', 'ops-section-title', longDay(day.date)), el('p', 'card-desc', `${day.entries.length} ${day.entries.length === 1 ? 'entry' : 'entries'}`));
    const items = el('ol', 'history-list');
    for (const entry of day.entries) items.append(row(entry));
    block.append(items);
    list.append(block);
  }

  function row(entry: ActivityEntry): HTMLElement {
    const item = el('li', 'history-item');
    const text = el('div', 'history-text');
    text.append(el('span', 'history-message', entry.message), el('span', 'rank-meta', [nameOf(entry.staffId), entry.branchId ? ops.branchName(entry.branchId) : ''].filter(Boolean).join(' · ')));
    item.append(el('time', 'history-time', clock(entry.at)), text, badge(AREA_LABELS[areaOf(entry.kind)], entry.kind.startsWith('alert.') ? 'warn' : 'muted'));
    if (entry.amount) item.append(el('span', 'history-amount', money(entry.amount)));
    return item;
  }

  root.body.append(stats, filters);
  if (matches.length === 0) {
    const empty = el('div', 'empty');
    empty.append(el('p', 'empty-title', 'Nothing in this view'), el('p', 'empty-desc', 'Widen the dates, or set Person, Area and Branch back to all.'));
    root.body.append(empty);
  } else {
    root.body.append(list);
  }
  if (matches.length > view.shown) {
    root.body.append(act(`Show more · ${(matches.length - view.shown).toLocaleString()} older`, 'btn btn-outline btn-block', () => {
      view.shown += PAGE;
      redraw();
    }));
  }
  return root.root;
}
