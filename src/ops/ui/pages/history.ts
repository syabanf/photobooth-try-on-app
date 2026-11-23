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

const longDay = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDay = (date: string) => (date ? new Date(`${date}T12:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) : 'kapan saja');
const clock = (time: number) => new Date(time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

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
  const nameOf = (staffId: string | null) => (staffId ? (state.staff.find((person) => person.id === staffId)?.name ?? 'Mantan staf') : 'Sistem');

  const root = page('Riwayat aktivitas', `Semua perubahan: penjualan, refund, pembayaran, antrean, wajah, log masuk, harga dan perangkat. Perangkat ini menyimpan ${ACTIVITY_LIMIT.toLocaleString('id-ID')} catatan terbaru; sisanya disimpan di cloud setelah sinkron.`);

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
  dates.append(input('date', view.from, 'Dari', (value) => (view.from = value)), input('date', view.to, 'Sampai', (value) => (view.to = value)));
  filters.append(
    dates,
    select('Orang', [['', 'Semua orang'], ...state.staff.map((person): [string, string] => [person.id, person.name]), ['system', 'Sistem dan peringatan']], view.staffId, (value) => (view.staffId = value)),
    select('Area', [['', 'Semua area'], ...(Object.keys(AREA_LABELS) as Area[]).map((area): [string, string] => [area, `${AREA_LABELS[area]}${areaCounts[area] ? ` · ${areaCounts[area]}` : ''}`])], view.area, (value) => (view.area = value as Area | '')),
    select('Cabang', [['', 'Semua cabang'], ...ops.visibleBranches().map((branch): [string, string] => [branch.id, branch.name])], view.branchId, (value) => (view.branchId = value)),
    input('search', view.query, 'Cari di riwayat', (value) => (view.query = value)),
    act('CSV', 'btn btn-outline btn-sm', () =>
      downloadText(
        toCsv(['Waktu', 'Orang', 'Area', 'Cabang', 'Yang terjadi', 'Jumlah'], matches.map((entry) => [new Date(entry.at).toISOString(), nameOf(entry.staffId), AREA_LABELS[areaOf(entry.kind)], entry.branchId ? ops.branchName(entry.branchId) : '', entry.message, entry.amount ?? ''])),
        `activity-${view.from}-to-${view.to}.csv`,
      ),
    'download'),
  );
  filters.querySelector('input[type=search]')!.setAttribute('placeholder', 'Kata, nomor pesanan, nama');

  // ---------- summary ----------
  const people = new Set(matches.map((entry) => entry.staffId).filter(Boolean));
  const moneyIn = matches.filter((entry) => areaOf(entry.kind) === 'sales' && entry.kind !== 'order.refund').reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
  const stats = statRow([
    { label: 'Catatan', value: matches.length.toLocaleString('id-ID'), hint: `${shortDay(view.from)} sampai ${shortDay(view.to)}` },
    { label: 'Orang', value: String(people.size), hint: 'Yang membuat perubahan' },
    { label: 'Uang tercatat', value: money(moneyIn), hint: 'Dari catatan penjualan' },
    { label: 'Peringatan', value: String(matches.filter((entry) => entry.kind.startsWith('alert.')).length), hint: 'Dari perangkat' },
  ]);

  // ---------- the days ----------
  const list = el('div', 'history-days');
  for (const day of byDay(matches.slice(0, view.shown), timeZone)) {
    const block = el('section', 'history-day');
    block.append(el('h3', 'ops-section-title', longDay(day.date)), el('p', 'card-desc', `${day.entries.length} catatan`));
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
    empty.append(el('p', 'empty-title', 'Tidak ada yang ditampilkan'), el('p', 'empty-desc', 'Perlebar rentang tanggal, atau kembalikan Orang, Area dan Cabang ke semua.'));
    root.body.append(empty);
  } else {
    root.body.append(list);
  }
  if (matches.length > view.shown) {
    root.body.append(act(`Tampilkan lagi · ${(matches.length - view.shown).toLocaleString('id-ID')} lebih lama`, 'btn btn-outline btn-block', () => {
      view.shown += PAGE;
      redraw();
    }));
  }
  return root.root;
}
