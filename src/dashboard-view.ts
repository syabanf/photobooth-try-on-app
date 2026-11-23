// The dashboard: captures over time, the busiest points and locations, and what needs attention.

import type { AccountBackend } from './account/backend';
import { TRIAL_LIMITS, trialDaysLeft, type Account, type Location, type Point, type Sites } from './account/model';
import { percentChange, summarize, type DayCount, type Ranked, type Summary } from './dashboard-stats';
import { actionButton, el, stat } from './dom';
import { SHOT_LABELS, listShots, type Shot } from './gallery';
import { shotMedia } from './gallery-view';
import { icon, type IconName } from './icons';
import { readStored, segmented, writeStored, type View } from './ui';

export interface DashboardHandlers {
  devicePointId(): string | null;
  pointLabel(id: string | null | undefined): string | null;
  onNavigate(view: View): void;
  onPickPoint(): void;
  /** The business card: today's revenue, booths online, alerts, queue. */
  today(): HTMLElement;
}

export interface DashboardView {
  refresh(): Promise<void>;
}

const PERIOD_KEY = 'vto:dashboard-days';
const RECENT = 6;

const amount = (count: number, noun: string) => `${count.toLocaleString('id-ID')} ${noun}`;
const dayLabel = (day: number, style: Intl.DateTimeFormatOptions) => new Date(day).toLocaleDateString('id-ID', style);

/** Rounds a chart's top up to 1, 2 or 5 times a power of ten, so gridline labels read cleanly. */
function niceMax(value: number): number {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((step) => step * power).find((candidate) => candidate >= value)!;
}

/** Captures per day as columns. Today takes the accent; every column shows its value on hover or focus. */
function dayChart(days: DayCount[]): HTMLElement {
  const top = niceMax(Math.max(...days.map((day) => day.count)));
  const chart = el('div', 'day-chart');
  const plot = el('div', 'chart-plot');
  for (const value of [top, top / 2]) {
    const grid = el('div', 'chart-grid');
    grid.style.bottom = `${(value / top) * 100}%`;
    grid.append(el('span', 'chart-grid-label', value.toLocaleString('id-ID')));
    plot.append(grid);
  }

  const tip = el('div', 'chart-tip');
  tip.hidden = true;
  const columns = el('div', 'chart-columns');
  days.forEach((day, index) => {
    const column = el('div', 'chart-col');
    column.tabIndex = 0;
    const label = `${dayLabel(day.day, { weekday: 'short', day: 'numeric', month: 'short' })} · ${amount(day.count, 'hasil foto')}`;
    column.setAttribute('aria-label', label);
    const bar = el('span', 'chart-bar');
    bar.classList.toggle('is-today', index === days.length - 1);
    bar.style.height = `${(day.count / top) * 100}%`;
    column.append(bar);
    const show = () => {
      tip.textContent = label;
      tip.hidden = false;
      tip.style.left = `${((index + 0.5) / days.length) * 100}%`;
    };
    column.addEventListener('pointerenter', show);
    column.addEventListener('focus', show);
    column.addEventListener('pointerleave', () => (tip.hidden = true));
    column.addEventListener('blur', () => (tip.hidden = true));
    columns.append(column);
  });
  plot.append(columns, tip);

  // Axis: first day, the week marks in a month view, and today.
  const axis = el('div', 'chart-axis');
  const step = days.length > 7 ? 7 : 1;
  days.forEach((day, index) => {
    const last = index === days.length - 1;
    const shown = last || (days.length - 1 - index) % step === 0;
    const text = last ? 'Hari ini' : dayLabel(day.day, days.length > 7 ? { day: 'numeric', month: 'short' } : { weekday: 'short' });
    axis.append(el('span', 'chart-tick', shown ? text : ''));
  });

  // The same numbers as a table, for screen readers.
  const table = el('table', 'sr-only');
  table.createCaption().textContent = 'Hasil foto per hari';
  for (const day of days) {
    const row = table.insertRow();
    row.insertCell().textContent = dayLabel(day.day, { dateStyle: 'medium' });
    row.insertCell().textContent = String(day.count);
  }

  chart.append(plot, axis, table);
  return chart;
}

/** A ranked list with a bar per row: the busiest first, the value at the bar's tip. */
function rankList<T>(entries: Ranked<T>[], name: (item: T) => string, meta: (item: T) => string): HTMLElement[] {
  const top = Math.max(1, ...entries.map((entry) => entry.count));
  return entries.map(({ item, count }) => {
    const row = el('div', 'rank-row');
    row.title = `${name(item)} · ${amount(count, 'hasil foto')}`;
    const text = el('div', 'rank-text');
    text.append(el('span', 'rank-name', name(item)), el('span', 'rank-meta', meta(item)));
    const track = el('div', 'rank-track');
    const bar = el('span', 'rank-bar');
    bar.style.width = `${(count / top) * 100}%`;
    track.append(bar);
    row.append(text, el('span', 'rank-value', count.toLocaleString('id-ID')), track);
    return row;
  });
}

function emptyNote(text: string): HTMLElement {
  return el('p', 'rank-empty', text);
}

export function mountDashboard(backend: AccountBackend, account: Account, handlers: DashboardHandlers): DashboardView {
  const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
  let days = readStored(PERIOD_KEY) === '30' ? 30 : 7;
  let urls: string[] = [];

  for (const button of $('#dashPeriod').querySelectorAll<HTMLElement>('button')) {
    button.classList.toggle('is-active', Number(button.dataset.days) === days);
  }
  segmented($('#dashPeriod'), (button) => {
    days = Number(button.dataset.days);
    writeStored(PERIOD_KEY, String(days));
    void view.refresh();
  });
  $('#dashOpenGallery').addEventListener('click', () => handlers.onNavigate('gallery'));

  function renderHero(summary: Summary): void {
    $('#dashPeriodLabel').textContent = `Hasil foto · ${days} hari terakhir`;
    $('#dashTotal').textContent = summary.total.toLocaleString('id-ID');
    const change = percentChange(summary.total, summary.previous);
    const delta = $<HTMLElement>('#dashDelta');
    delta.replaceChildren();
    if (change === null) {
      delta.dataset.direction = 'flat';
      delta.append(summary.total ? `Kosong di ${days} hari sebelumnya` : `Belum ada dalam ${days} hari terakhir`);
    } else {
      delta.dataset.direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
      if (change !== 0) delta.append(icon(change > 0 ? 'up' : 'down'));
      delta.append(`${change > 0 ? '+' : ''}${change}% dibanding ${days} hari sebelumnya`);
    }
    $('#dashChart').replaceChildren(dayChart(summary.days));
  }

  function renderAttention(summary: Summary, sites: Sites): void {
    const card = $<HTMLElement>('#dashAttention');
    const items: { icon: IconName; text: string; action?: [string, () => void] }[] = [];
    const daysLeft = trialDaysLeft(account, Date.now());
    if (daysLeft <= 3) items.push({ icon: 'clock', text: `Masa coba berakhir dalam ${amount(daysLeft, 'hari')}.` });
    if (sites.locations.length === 0) {
      items.push({ icon: 'pin', text: 'Belum ada lokasi.', action: ['Tambah', () => handlers.onNavigate('sites')] });
    } else if (sites.points.length === 0) {
      items.push({ icon: 'point', text: 'Belum ada booth.', action: ['Tambah', () => handlers.onNavigate('sites')] });
    }
    if (sites.points.length > 0 && !handlers.devicePointId()) {
      items.push({ icon: 'point', text: 'Perangkat ini belum terhubung ke booth.', action: ['Pilih', handlers.onPickPoint] });
    }
    if (summary.idlePoints.length) {
      const names = summary.idlePoints.slice(0, 3).map((point) => point.name).join(', ');
      const more = summary.idlePoints.length > 3 ? ` dan ${summary.idlePoints.length - 3} lainnya` : '';
      items.push({
        icon: 'alert',
        text: `${amount(summary.idlePoints.length, 'booth aktif')} tidak memotret apa pun dalam ${days} hari: ${names}${more}.`,
        action: ['Lihat', () => handlers.onNavigate('sites')],
      });
    }

    card.dataset.state = items.length ? 'alert' : 'clear';
    const head = el('div', 'attention-head');
    head.append(el('p', 'kicker', 'Perlu perhatian'), el('span', 'attention-count', String(items.length)));
    if (items.length === 0) {
      const clear = el('div', 'attention-clear');
      clear.append(icon('ok'), el('span', '', 'Semua aman. Setiap booth aktif sedang memotret.'));
      card.replaceChildren(head, clear);
      return;
    }
    const list = el('ul', 'attention-list');
    for (const item of items) {
      const row = el('li', 'attention-item');
      row.append(icon(item.icon), el('span', 'attention-text', item.text));
      if (item.action) {
        const [label, run] = item.action;
        const button = actionButton(label, 'btn btn-sm attention-action');
        button.addEventListener('click', run);
        row.append(button);
      }
      list.append(row);
    }
    card.replaceChildren(head, list);
  }

  function renderStats(summary: Summary, sites: Sites): void {
    const active = sites.points.filter((point) => point.active).length;
    $('#dashStats').replaceChildren(
      stat('Foto', summary.snapshots.toLocaleString('id-ID'), `dalam ${days} hari`, 'camera', 'soft'),
      stat('Lembar photobooth', summary.sheets.toLocaleString('id-ID'), `dalam ${days} hari`, 'aperture', 'soft'),
      stat('Booth aktif', String(active), `dari ${sites.points.length} · masa coba maks. ${TRIAL_LIMITS.points}`, 'point', 'soft'),
      stat('Lokasi', String(sites.locations.length), `masa coba maks. ${TRIAL_LIMITS.locations}`, 'pin', 'soft'),
    );
  }

  function renderRanks(summary: Summary, sites: Sites): void {
    const locationName = (point: Point) => sites.locations.find((location) => location.id === point.locationId)?.name ?? '';
    const points = $('#dashPoints');
    points.replaceChildren(
      ...(summary.points.length
        ? rankList(
            summary.points.slice(0, 6),
            (point) => point.name,
            (point) => `${locationName(point)} · ${point.code}${point.active ? '' : ' · dijeda'}`,
          )
        : [emptyNote('Tambahkan booth di halaman Lokasi dan booth untuk melihat peringkatnya di sini.')]),
    );
    const pointsIn = (location: Location) => sites.points.filter((point) => point.locationId === location.id).length;
    $('#dashLocations').replaceChildren(
      ...(summary.locations.length
        ? rankList(summary.locations, (location) => location.name, (location) => `${location.city} · ${amount(pointsIn(location), 'booth')}`)
        : [emptyNote('Belum ada lokasi.')]),
    );
  }

  function renderRecent(shots: Shot[]): void {
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    const recent = shots.slice(0, RECENT);
    $('#dashRecent').replaceChildren(
      ...(recent.length
        ? recent.map((shot) => {
            const url = URL.createObjectURL(shot.blob);
            urls.push(url);
            const card = el('button', 'recent-shot');
            card.type = 'button';
            const media = shotMedia(shot, url);
            const meta = el('span', 'recent-meta');
            meta.append(
              el('span', 'rank-name', SHOT_LABELS[shot.kind]),
              el('span', 'rank-meta', handlers.pointLabel(shot.pointId) ?? 'Tanpa booth'),
            );
            card.append(media, meta);
            card.addEventListener('click', () => handlers.onNavigate('gallery'));
            return card;
          })
        : [emptyNote('Foto dan lembar photobooth muncul di sini setelah ada yang memotret.')]),
    );
  }

  const view: DashboardView = {
    async refresh() {
      const [sites, shots] = await Promise.all([backend.sites(), listShots()]);
      const summary = summarize(shots, sites, days, Date.now());
      $('#dashToday').replaceChildren(handlers.today());
      renderHero(summary);
      renderAttention(summary, sites);
      renderStats(summary, sites);
      renderRanks(summary, sites);
      renderRecent(shots);
    },
  };
  return view;
}
