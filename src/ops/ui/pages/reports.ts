// Reports over one date range: a summary against the period before, sales (by day, branch, booth,
// shift, frame or mode), products, payments by method with fees, cash per shift, busy hours, each
// cashier's sales, refunds and cancellations, vouchers and discounts, the floor (queue, gate and AI
// prints), and the settlement check of a gateway export. Every table exports to CSV, sales and
// payments also to XLSX, and the close of a day prints on one page.

import { seesBranch } from '../../access';
import { printDocument } from '../../adapters';
import { busyHours, change, compareRange, dailySeries, daysBetween, discountReport, matchesFilter, NO_FILTER, staffReport, takenByMethod, totals, type Compare, type Metric, type Totals } from '../../insights';
import { xlsx } from '../../encoders';
import { PAYMENT_LABELS, PAYMENT_METHODS, SESSION_MODES, type LineKind, type PaymentMethod, type SessionMode } from '../../model';
import { paymentReport, type PaymentGroup } from '../../payments';
import { shiftSlip } from '../../shift';
import { bestSellers, floorReport, parseGatewayCsv, PRODUCT_LABELS, reconcileSettlement, revenueReport, toCsv, type GroupBy, type ReportRow, type Settlement } from '../../reports';
import { localTimeZone, zonedTime } from '../../time';
import type { PageContext } from '../router';
import { act, badge, dateTime, downloadBytes, downloadText, el, fileInput, money, notice, page, pills, section, statRow, table } from '../kit';

type Tab = 'summary' | 'sales' | 'products' | 'payments' | 'cash' | 'hours' | 'staff' | 'discounts' | 'floor' | 'settlement';
type Range = 'today' | '7' | '30' | 'month' | 'custom';

const view = { tab: 'summary' as Tab, heat: 'orders' as 'orders' | 'revenue', filter: { ...NO_FILTER }, compare: 'previous' as Compare, metric: 'net' as Metric, range: '30' as Range, groupBy: 'day' as GroupBy, payGroup: 'method' as PaymentGroup, from: '', to: '', settlement: null as Settlement | null, fileName: '' };

const TABS: { value: Tab; label: string }[] = [
  { value: 'summary', label: 'Ringkasan' },
  { value: 'sales', label: 'Penjualan' },
  { value: 'products', label: 'Produk' },
  { value: 'payments', label: 'Pembayaran' },
  { value: 'cash', label: 'Tunai' },
  { value: 'hours', label: 'Jam ramai' },
  { value: 'staff', label: 'Kasir' },
  { value: 'discounts', label: 'Voucher dan diskon' },
  { value: 'floor', label: 'Lantai' },
  { value: 'settlement', label: 'Rekonsiliasi' },
];

const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: 'Hari ini' },
  { value: '7', label: '7 hari' },
  { value: '30', label: '30 hari' },
  { value: 'month', label: 'Bulan ini' },
  { value: 'custom', label: 'Pilih tanggal' },
];

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Monday first, as the crew reads a week; `zonedTime` counts from Sunday. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}.00`;
const shortDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayMonth = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "Naik 12% dari 1–7 Nov", or a plain note when the period before had nothing. */
function versus(now: number, before: number, period: string): string {
  const percent = change(now, before);
  if (percent === null) return now ? `Tidak ada data ${period} untuk dibandingkan` : '';
  return percent === 0 ? `Sama dengan ${period}` : `${percent > 0 ? 'Naik' : 'Turun'} ${Math.abs(percent)}% dari ${period}`;
}

const COMPARES: { value: Compare; label: string }[] = [
  { value: 'previous', label: 'Periode sebelumnya' },
  { value: 'year', label: 'Tahun lalu' },
  { value: 'none', label: 'Tanpa pembanding' },
];

const METRICS: { value: Metric; label: string }[] = [
  { value: 'net', label: 'Pendapatan bersih' },
  { value: 'orders', label: 'Transaksi' },
  { value: 'sessions', label: 'Sesi foto' },
];

/** Short amounts for chart labels: 1,2 jt, 350 rb. */
function compact(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt`;
  if (Math.abs(amount) >= 1_000) return `${Math.round(amount / 1_000)} rb`;
  return String(amount);
}

/**
 * Columns per day for this range, each with a mark where the compared period stood on its matching
 * day (day 1 against day 1), so a better or worse day shows without reading numbers.
 */
function trendChart(days: readonly string[], now: readonly number[], was: readonly number[] | null, format: (value: number) => string): HTMLElement {
  const top = Math.max(1, ...now, ...(was ?? []));
  const chart = el('div', 'trend');
  const plot = el('div', 'trend-plot');
  plot.append(el('span', 'trend-max', format(top)));
  days.forEach((day, at) => {
    const column = el('div', 'trend-col');
    column.title = `${shortDate(day)}: ${format(now[at])}${was ? ` · pembanding ${format(was[at] ?? 0)}` : ''}`;
    const bar = el('span', 'trend-bar');
    bar.style.height = `${(now[at] / top) * 100}%`;
    column.append(bar);
    // A mark on an empty compared day would only underline the axis.
    if (was?.[at]) {
      const mark = el('span', 'trend-mark');
      mark.style.bottom = `${(was[at] / top) * 100}%`;
      column.append(mark);
    }
    plot.append(column);
  });
  const axis = el('div', 'trend-axis');
  // First, middle and last day, so a month of columns stays readable on a phone.
  for (const at of [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])]) axis.append(el('span', '', shortDate(days[at])));
  chart.append(plot, axis);
  return chart;
}

/** Coloured key for a chart: this range, and the compared period when there is one. */
function chartLegend(now: string, before: string): HTMLElement {
  const legend = el('p', 'trend-legend');
  legend.append(el('span', 'trend-key trend-key--now'), now);
  if (before) legend.append(el('span', 'trend-key trend-key--before'), before);
  return legend;
}

/** One row per group: this period's bar, and a thin bar under it for the compared period. */
function compareBars(rows: readonly { label: string; now: number; before: number | null }[], format: (value: number) => string, legend: HTMLElement): HTMLElement {
  const top = Math.max(1, ...rows.flatMap((row) => [row.now, row.before ?? 0]));
  const list = el('div', 'compare-bars');
  list.append(legend);
  for (const row of rows.slice(0, 12)) {
    const item = el('div', 'compare-row');
    const tracks = el('div', 'compare-tracks');
    const now = el('span', 'compare-now');
    now.style.width = `${(Math.max(0, row.now) / top) * 100}%`;
    tracks.append(now);
    if (row.before !== null) {
      const before = el('span', 'compare-before');
      before.style.width = `${(Math.max(0, row.before) / top) * 100}%`;
      tracks.append(before);
    }
    const percent = row.before === null ? null : change(row.now, row.before);
    const value = el('span', 'compare-value', format(row.now));
    if (percent !== null && percent !== 0) value.append(el('small', percent > 0 ? 'is-up' : 'is-down', ` ${percent > 0 ? '+' : ''}${percent}%`));
    item.append(el('span', 'compare-label', row.label), tracks, value);
    list.append(item);
  }
  return list;
}

const GROUPS: { value: GroupBy; label: string }[] = [
  { value: 'day', label: 'Hari' },
  { value: 'branch', label: 'Cabang' },
  { value: 'booth', label: 'Booth' },
  { value: 'shift', label: 'Shift' },
  { value: 'frame', label: 'Bingkai' },
  { value: 'mode', label: 'Mode' },
];

/** The first and last day a quick range covers, in this device's time zone. */
function rangeDates(range: Range, zone: string): { from: string; to: string } {
  const day = (offset: number) => zonedTime(Date.now() - offset * 86_400_000, zone).date;
  const today = day(0);
  if (range === 'today') return { from: today, to: today };
  if (range === '7') return { from: day(6), to: today };
  if (range === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: day(29), to: today };
}

export function renderReports({ ops, redraw }: PageContext): HTMLElement {
  const { state } = ops;
  const zone = localTimeZone();
  const today = zonedTime(Date.now(), zone).date;
  if (!view.from || view.range !== 'custom') Object.assign(view, rangeDates(view.range, zone));
  const inRange = (time: number) => {
    const date = zonedTime(time, zone).date;
    return date >= view.from && date <= view.to;
  };
  const actor = ops.actor();
  const { filter } = view;
  /** Orders, booth sessions and refunds between two days that the filter keeps. */
  const scope = (from: string, to: string) => {
    const within = (time: number) => {
      const date = zonedTime(time, zone).date;
      return date >= from && date <= to;
    };
    const orders = state.orders.filter((order) => seesBranch(actor, order.branchId) && matchesFilter(order, filter) && within(order.paidAt ?? order.createdAt));
    const ids = new Set(orders.map((order) => order.id));
    // Sessions happen at a booth, so a till, cashier or channel filter other than booth leaves none.
    const tillOnly = filter.boothId === 'cashier' || filter.channel === 'cashier' || !!filter.staffId;
    const sessions = tillOnly ? [] : state.sessions.filter((session) => seesBranch(actor, session.branchId) && (!filter.branchId || session.branchId === filter.branchId) && (!filter.boothId || session.boothId === filter.boothId) && within(session.startedAt));
    return { orders, sessions, refunds: state.refunds.filter((refund) => within(refund.at) && ids.has(refund.orderId)) };
  };
  const { orders, sessions, refunds } = scope(view.from, view.to);
  const compared = compareRange(view.from, view.to, view.compare);
  const earlier = compared ? scope(compared.from, compared.to) : null;
  const span = (from: string, to: string) => (from === to ? dayMonth(from) : `${dayMonth(from)}–${dayMonth(to)}`);
  const period = compared ? span(compared.from, compared.to) : '';
  const legend = () => chartLegend(span(view.from, view.to), period);
  const label = (groupBy: GroupBy, key: string): string => {
    if (groupBy === 'branch') return ops.branchName(key);
    if (groupBy === 'booth') return key === 'cashier' ? 'Kasir' : ops.boothName(key);
    if (groupBy === 'product') return PRODUCT_LABELS[key as LineKind] ?? key;
    if (groupBy === 'frame') return key === 'none' ? 'Tanpa bingkai' : (state.frames.find((frame) => frame.id === key)?.name ?? 'Bingkai terhapus');
    if (groupBy === 'mode') return SESSION_MODES[key as SessionMode]?.label ?? key;
    if (groupBy === 'shift') {
      const shift = state.shifts.find((entry) => entry.id === key);
      return shift ? `${ops.branchName(shift.branchId)} · ${new Date(shift.openedAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Tanpa shift';
    }
    return key;
  };
  const revenue = (groupBy: GroupBy, data: { orders: typeof orders; sessions: typeof sessions } = { orders, sessions }) => revenueReport({ orders: data.orders, refunds: state.refunds, sessions: data.sessions, timeZone: zone, label }, groupBy);
  /** Each group's net now, beside its net in the compared period. */
  const netBars = (rows: ReportRow[], groupBy: GroupBy) => {
    const before = earlier ? new Map(revenue(groupBy, earlier).map((row) => [row.key, row.net])) : null;
    return compareBars(rows.map((row) => ({ label: row.label, now: row.net, before: before ? (before.get(row.key) ?? 0) : null })), money, legend());
  };
  const sum = (rows: ReportRow[]) => rows.reduce((total, row) => ({ gross: total.gross + row.gross, refunds: total.refunds + row.refunds, net: total.net + row.net }), { gross: 0, refunds: 0, net: 0 });
  const exports = (actions: HTMLElement, name: string, headers: string[], rows: (string | number)[][], sheet?: string) => {
    actions.append(act('CSV', 'btn btn-outline btn-sm', () => downloadText(toCsv(headers, rows), `${name}-${view.from}-to-${view.to}.csv`), 'download'));
    if (sheet) actions.append(act('XLSX', 'btn btn-outline btn-sm', () => downloadBytes(xlsx(sheet, headers, rows), `${name}-${view.from}-to-${view.to}.xlsx`, XLSX_TYPE), 'download'));
  };

  const root = page('Laporan', 'Pilih tanggal sekali; semua tab memakai rentang yang sama. Hasil ekspor bisa dibuka di Excel atau Google Sheets.');
  root.actions.append(act(`Cetak tutup hari ${shortDate(view.to)}`, 'btn btn-outline btn-sm', () => printDayClose(view.to), 'printer'));
  const staffName = (id: string | null) => (id === null ? 'Kiosk dan booth' : (state.staff.find((person) => person.id === id)?.name ?? 'Staf terhapus'));
  const ordersOn = (match: (date: string) => boolean) => state.orders.filter((order) => seesBranch(actor, order.branchId) && match(zonedTime(order.paidAt ?? order.createdAt, zone).date));

  // ---------- the range, the filters and the tabs ----------
  const controls = el('div', 'ops-filters');
  const from = el('input', 'input');
  from.type = 'date';
  from.value = view.from;
  from.setAttribute('aria-label', 'Dari');
  const to = el('input', 'input');
  to.type = 'date';
  to.value = view.to;
  to.setAttribute('aria-label', 'Sampai');
  for (const input of [from, to]) {
    input.addEventListener('change', () => {
      view.range = 'custom';
      view.from = from.value || view.from;
      view.to = to.value || view.to;
      redraw();
    });
  }
  const dates = el('div', 'date-range');
  dates.append(from, to);
  controls.append(pills(RANGES, view.range, (range) => {
    view.range = range;
    redraw();
  }), dates);

  const choose = (name: string, value: string, options: [string, string][], onPick: (value: string) => void) => {
    const select = el('select', 'input select report-filter');
    select.setAttribute('aria-label', name);
    for (const [key, text] of options) select.add(new Option(text, key, false, key === value));
    select.addEventListener('change', () => {
      onPick(select.value);
      redraw();
    });
    return select;
  };
  const branches = ops.visibleBranches();
  const booths = ops.visibleBooths().filter((point) => !filter.branchId || point.locationId === filter.branchId);
  const filters = el('div', 'report-filters');
  filters.append(
    choose('Lokasi', filter.branchId, [['', 'Semua lokasi'], ...branches.map((branch): [string, string] => [branch.id, branch.name])], (value) => {
      filter.branchId = value;
      filter.boothId = '';
    }),
    choose('Booth', filter.boothId, [['', 'Semua booth'], ['cashier', 'Kasir (meja kasir)'], ...booths.map((point): [string, string] => [point.id, point.name])], (value) => (filter.boothId = value)),
    choose('Saluran', filter.channel, [['', 'Semua saluran'], ['cashier', 'Kasir'], ['booth', 'Booth dan kiosk']], (value) => (filter.channel = value as typeof filter.channel)),
    choose('Kasir', filter.staffId, [['', 'Semua orang'], ...state.staff.map((person): [string, string] => [person.id, person.name])], (value) => (filter.staffId = value)),
    choose('Bandingkan dengan', view.compare, COMPARES.map((entry): [string, string] => [entry.value, `Bandingkan: ${entry.label.toLowerCase()}`]), (value) => (view.compare = value as Compare)),
  );
  if (Object.values(filter).some(Boolean)) {
    filters.append(act('Hapus filter', 'btn btn-ghost btn-sm', () => {
      Object.assign(filter, NO_FILTER);
      redraw();
    }, 'close'));
  }
  root.body.append(
    pills(TABS, view.tab, (tab) => {
      view.tab = tab;
      redraw();
    }),
    controls,
    filters,
  );

  const tabs: Record<Tab, () => HTMLElement[]> = { summary: summaryTab, sales: salesTab, products: productsTab, payments: paymentsTab, cash: cashTab, hours: hoursTab, staff: staffTab, discounts: discountsTab, floor: floorTab, settlement: settlementTab };
  root.body.append(...tabs[view.tab]());
  return root.root;

  // ---------- sales ----------
  function salesTab(): HTMLElement[] {
    const rows = revenue(view.groupBy);
    const totals = sum(rows);
    const headers = ['Kelompok', 'Pesanan', 'Sesi terjual', 'Kotor', 'Refund', 'Bersih'];
    const sales = section('Penjualan', 'Pendapatan dikelompokkan sesuai kebutuhan. Bingkai dan mode menghitung sesi booth sesuai harganya.');
    const salesChart = view.groupBy === 'day' ? dayTrend('net') : netBars(rows, view.groupBy);
    exports(sales.actions, `sales-${view.groupBy}`, headers, rows.map((row) => [row.label, row.orders, row.sessions, row.gross, row.refunds, row.net]), 'Penjualan');
    sales.body.append(salesChart);
    sales.body.append(
      pills(GROUPS, view.groupBy, (groupBy) => {
        view.groupBy = groupBy;
        redraw();
      }),
      statRow([
        { label: 'Kotor', value: money(totals.gross) },
        { label: 'Refund', value: money(totals.refunds) },
        { label: 'Bersih', value: money(totals.net) },
        { label: 'Sesi booth', value: String(sessions.length), hint: `${orders.filter((o) => o.status === 'paid').length} pesanan lunas` },
      ]),
      table(
        [
          { label: GROUPS.find((group) => group.value === view.groupBy)!.label, cell: (row) => row.label },
          { label: 'Pesanan', className: 'num', cell: (row) => String(row.orders) },
          { label: 'Sesi terjual', className: 'num', cell: (row) => String(row.sessions) },
          { label: 'Kotor', className: 'num', cell: (row) => money(row.gross) },
          { label: 'Refund', className: 'num', cell: (row) => (row.refunds ? `−${money(row.refunds)}` : '—') },
          { label: 'Bersih', className: 'num', cell: (row) => money(row.net) },
        ],
        rows,
        { empty: 'Tidak ada penjualan di tanggal ini.' },
      ),
    );
    return [sales.root];
  }

  // ---------- products ----------
  function productsTab(): HTMLElement[] {
    const rows = revenue('product');
    const totals = sum(rows);
    const products = section('Yang terjual', 'Setiap jenis barang yang terjual, dari baris pesanan: sesi foto, preset AI (booth dan kiosk), cetakan tambahan, cetak ulang dan merchandise. Refund dihitung pada baris yang dikembalikan.');
    exports(products.actions, 'products', ['Produk', 'Pesanan', 'Kotor', 'Refund', 'Bersih', 'Porsi dari bersih'], rows.map((row) => [row.label, row.orders, row.gross, row.refunds, row.net, totals.net ? Math.round((row.net / totals.net) * 100) : 0]), 'Produk');
    products.body.append(
      netBars(rows, 'product'),
      statRow(rows.slice(0, 4).map((row) => ({ label: row.label, value: money(row.net), hint: `${totals.net ? Math.round((row.net / totals.net) * 100) : 0}% dari bersih · ${row.orders} pesanan` }))),
      table(
        [
          { label: 'Produk', cell: (row) => row.label },
          { label: 'Pesanan', className: 'num', cell: (row) => String(row.orders) },
          { label: 'Kotor', className: 'num', cell: (row) => money(row.gross) },
          { label: 'Refund', className: 'num', cell: (row) => (row.refunds ? `−${money(row.refunds)}` : '—') },
          { label: 'Bersih', className: 'num', cell: (row) => money(row.net) },
          { label: 'Porsi', className: 'num', cell: (row) => `${totals.net ? Math.round((row.net / totals.net) * 100) : 0}%` },
        ],
        rows,
        { empty: 'Tidak ada penjualan di tanggal ini.' },
      ),
    );
    const top = bestSellers(orders).slice(0, 10);
    const best = section('Terlaris', 'Sepuluh item yang paling banyak terjual menurut jumlah, tanpa baris yang di-refund. Peringkat bingkai menurut sesi ada di Penjualan → Bingkai.');
    exports(best.actions, 'best-sellers', ['Item', 'Terjual', 'Pendapatan'], top.map((row) => [row.label, row.qty, row.revenue]));
    best.body.append(table([{ label: 'Item', cell: (row) => row.label }, { label: 'Terjual', className: 'num', cell: (row) => String(row.qty) }, { label: 'Pendapatan', className: 'num', cell: (row) => money(row.revenue) }], top, { empty: 'Belum ada yang terjual.' }));
    return [products.root, best.root];
  }

  // ---------- payments ----------
  function paymentsTab(): HTMLElement[] {
    const payRows = paymentReport(
      { orders, refunds, dayOf: (time) => zonedTime(time, zone).date, label: (group, key) => (group === 'method' ? PAYMENT_LABELS[key as PaymentMethod] : label(group, key)) },
      view.payGroup,
    );
    const payTotals = payRows.reduce((sum, row) => ({ count: sum.count + row.count, gross: sum.gross + row.gross, fees: sum.fees + row.fees, refunds: sum.refunds + row.refunds, net: sum.net + row.net }), { count: 0, gross: 0, fees: 0, refunds: 0, net: 0 });
    const PAY_GROUPS: { value: PaymentGroup; label: string }[] = [
      { value: 'method', label: 'Metode' },
      { value: 'day', label: 'Hari' },
      { value: 'branch', label: 'Cabang' },
      { value: 'booth', label: 'Booth' },
      { value: 'shift', label: 'Shift' },
    ];
    const pays = section('Pembayaran', 'Uang masuk per metode, biaya prosesnya, dan yang sampai ke bank atau laci setelah refund. Tanggalnya sama dengan di atas.');
    const payHeaders = ['Kelompok', 'Pembayaran', 'Kotor', 'Biaya', 'Refund', 'Bersih'];
    const payCells = (row: (typeof payRows)[number]) => [row.label, row.count, row.gross, row.fees, row.refunds, row.net];
    const payFile = `payments-${view.payGroup}-${view.from}-to-${view.to}`;
    pays.actions.append(
      act('CSV', 'btn btn-outline btn-sm', () => downloadText(toCsv(payHeaders, payRows.map(payCells)), `${payFile}.csv`), 'download'),
      act('XLSX', 'btn btn-outline btn-sm', () => downloadBytes(xlsx('Pembayaran', payHeaders, payRows.map(payCells)), `${payFile}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'download'),
    );
    const earlierPays = earlier && view.payGroup !== 'day' ? new Map(paymentReport({ orders: earlier.orders, refunds: earlier.refunds, dayOf: (time) => zonedTime(time, zone).date, label: () => '' }, view.payGroup).map((row) => [row.key, row.net])) : null;
    pays.body.append(
      pills(PAY_GROUPS, view.payGroup, (group) => {
        view.payGroup = group;
        redraw();
      }),
      view.payGroup === 'day' ? dayTrend('net') : compareBars(payRows.map((row) => ({ label: row.label, now: row.net, before: earlierPays ? (earlierPays.get(row.key) ?? 0) : null })), money, legend()),
      statRow([
        ...PAYMENT_METHODS.map((method) => {
          const row = paymentReport({ orders, refunds, dayOf: () => '', label: () => '' }, 'method').find((entry) => entry.key === method);
          return { label: PAYMENT_LABELS[method], value: money(row?.gross ?? 0), hint: row ? `${row.count} pembayaran · biaya ${money(row.fees)}` : 'Tidak ada' };
        }),
      ]),
      table(
        [
          { label: PAY_GROUPS.find((group) => group.value === view.payGroup)!.label, cell: (row) => row.label },
          { label: 'Pembayaran', className: 'num', cell: (row) => String(row.count) },
          { label: 'Kotor', className: 'num', cell: (row) => money(row.gross) },
          { label: 'Biaya', className: 'num', cell: (row) => (row.fees ? `−${money(row.fees)}` : '—') },
          { label: 'Refund', className: 'num', cell: (row) => (row.refunds ? `−${money(row.refunds)}` : '—') },
          { label: 'Bersih', className: 'num', cell: (row) => money(row.net) },
        ],
        payRows,
        { empty: 'Tidak ada pembayaran di tanggal ini.' },
      ),
      el('p', 'field-hint', `${payTotals.count} pembayaran · kotor ${money(payTotals.gross)} · biaya ${money(payTotals.fees)} · refund ${money(payTotals.refunds)} · bersih ${money(payTotals.net)}`),
    );
    return [pays.root];
  }

  // ---------- cash ----------
  function cashTab(): HTMLElement[] {
    const shifts = state.shifts.filter((shift) => seesBranch(actor, shift.branchId) && inRange(shift.openedAt)).sort((a, b) => b.openedAt - a.openedAt);
    const deposits = section('Tunai per shift', 'Laci di akhir setiap shift: berapa yang seharusnya ada, berapa yang dihitung, dan selisihnya. Shift yang masih buka menampilkan jumlah seharusnya sejauh ini.');
    const slips = shifts.map((shift) => ({ shift, slip: shiftSlip(shift, state.orders, state.refunds) }));
    const depositHeaders = ['Cabang', 'Dibuka', 'Ditutup', 'Modal awal', 'Tunai masuk', 'Refund tunai', 'Seharusnya', 'Dihitung', 'Selisih'];
    const depositCells = ({ shift, slip }: (typeof slips)[number]) => [ops.branchName(shift.branchId), new Date(shift.openedAt).toISOString(), shift.closedAt ? new Date(shift.closedAt).toISOString() : '', slip.openingCash, slip.byMethod.cash, slip.refundsByMethod.cash, slip.expectedCash, slip.countedCash ?? '', slip.variance ?? ''];
    deposits.actions.append(act('CSV', 'btn btn-outline btn-sm', () => downloadText(toCsv(depositHeaders, slips.map(depositCells)), `cash-shifts-${view.from}-to-${view.to}.csv`), 'download'));
    deposits.body.append(
      table(
        [
          { label: 'Cabang', cell: ({ shift }: (typeof slips)[number]) => ops.branchName(shift.branchId) },
          { label: 'Dibuka', cell: ({ shift }) => new Date(shift.openedAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) },
          { label: 'Ditutup', cell: ({ shift }) => (shift.closedAt ? new Date(shift.closedAt).toLocaleTimeString('id-ID', { timeStyle: 'short' }) : badge('Buka', 'ok')) },
          { label: 'Modal awal', className: 'num', cell: ({ slip }) => money(slip.openingCash) },
          { label: 'Tunai masuk', className: 'num', cell: ({ slip }) => money(slip.byMethod.cash) },
          { label: 'Refund tunai', className: 'num', cell: ({ slip }) => (slip.refundsByMethod.cash ? `−${money(slip.refundsByMethod.cash)}` : '—') },
          { label: 'Seharusnya', className: 'num', cell: ({ slip }) => money(slip.expectedCash) },
          { label: 'Dihitung', className: 'num', cell: ({ slip }) => (slip.countedCash === null ? '—' : money(slip.countedCash)) },
          { label: 'Selisih', className: 'num', cell: ({ slip }) => (slip.variance === null ? '—' : badge(slip.variance === 0 ? 'Cocok' : `${slip.variance > 0 ? '+' : ''}${money(slip.variance)}`, slip.variance === 0 ? 'ok' : 'warn')) },
        ],
        slips,
        { empty: 'Tidak ada shift di tanggal ini.' },
      ),
    );
    return [deposits.root];
  }

  // ---------- floor ----------
  function floorTab(): HTMLElement[] {
    const tickets = state.tickets.filter((ticket) => inRange(ticket.createdAt) && ticket.boothIds.some((boothId) => seesBranch(actor, ops.branchOf(boothId))));
    const faces = state.faces.filter((face) => inRange(face.createdAt) && seesBranch(actor, ops.branchOf(face.boothId)));
    const floor = floorReport({ tickets, faces, orders, timeZone: zone });
    const report = section('Lantai', 'Jalannya hari di lantai: antrean, kamera gerbang, dan cetakan AI yang dibeli rombongan di booth atau kiosk.');
    exports(report.actions, 'floor-by-hour', ['Jam', 'Tiket'], floor.byHour.map((count, hour) => [`${String(hour).padStart(2, '0')}:00`, count]));
    const busiest = Math.max(...floor.byHour);
    const chart = el('div', 'hour-bars');
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', `Tiket per jam; jam tersibuk punya ${busiest} tiket.`);
    for (const [hour, count] of floor.byHour.entries()) {
      if (hour < 7 || hour > 22) continue;
      const bar = el('div', 'hour-bar');
      const fill = el('span', `hour-bar-fill${count === busiest && busiest > 0 ? ' is-peak' : ''}`);
      fill.style.height = `${busiest ? (count / busiest) * 100 : 0}%`;
      bar.title = `${String(hour).padStart(2, '0')}:00 · ${count} tiket`;
      bar.append(el('span', 'hour-bar-count', count ? String(count) : ''), fill, el('span', 'hour-bar-label', String(hour).padStart(2, '0')));
      chart.append(bar);
    }
    report.body.append(
      statRow([
        { label: 'Tiket', value: String(floor.tickets), hint: `${floor.served} dilayani · ${floor.skipped} dilewati` },
        { label: 'Rata-rata tunggu', value: floor.averageWait === null ? '—' : `${Math.round(floor.averageWait)} menit`, hint: 'Dari tiket sampai dipanggil' },
        { label: 'Rombongan difoto', value: String(floor.partiesPhotographed), hint: `${floor.faces} wajah di gerbang` },
        { label: 'Cetakan AI', value: String(floor.presetPrints), hint: floor.partiesPhotographed ? `${(floor.presetPrints / floor.partiesPhotographed).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} per rombongan · ${money(floor.presetRevenue)}` : money(floor.presetRevenue) },
      ]),
      el('p', 'kicker', 'Tiket per jam, 07.00 sampai 22.00'),
      chart,
    );
    return [report.root];
  }

  // ---------- settlement ----------
  function settlementTab(): HTMLElement[] {
    const settle = section('Rekonsiliasi', 'Unggah ekspor settlement QRIS dari gateway untuk dicocokkan dengan pembayaran yang tercatat di sini.');
    const upload = fileInput('.csv,text/csv', async (file) => {
      try {
        const rowsIn = parseGatewayCsv(await file.text());
        const payments = state.orders.flatMap((order) => order.payments);
        view.settlement = reconcileSettlement(payments, rowsIn);
        view.fileName = file.name;
        redraw();
      } catch (error) {
        notice((error as Error).message, 'error');
      }
    });
    settle.actions.append(upload, act('Unggah ekspor', 'btn btn-outline btn-sm', () => upload.click(), 'upload'));
    const result = view.settlement;
    if (!result) {
      settle.body.append(el('p', 'card-desc', 'File perlu kolom referensi (order_id) dan nominal (gross_amount); kolom status dan fee dibaca bila ada.'));
    } else {
      settle.body.append(
        el('p', 'card-desc', view.fileName),
        statRow([
          { label: 'Cocok', value: String(result.matched.length) },
          { label: 'Nominal berbeda', value: String(result.mismatched.length) },
          { label: 'Hanya di gateway', value: String(result.missingInLedger.length) },
          { label: 'Hanya di pembukuan', value: String(result.missingInGateway.length) },
        ]),
        el('p', 'card-desc', `Pembukuan ${money(result.ledgerTotal)} · gateway ${money(result.gatewayTotal)} · biaya ${money(result.fees)} · selisih ${money(result.gatewayTotal - result.ledgerTotal)}`),
        table(
          [
            { label: 'Referensi', cell: (row: { reference: string; problem: string; ledger: string; gateway: string }) => row.reference },
            { label: 'Masalah', cell: (row) => badge(row.problem, 'warn') },
            { label: 'Pembukuan', className: 'num', cell: (row) => row.ledger },
            { label: 'Gateway', className: 'num', cell: (row) => row.gateway },
          ],
          [
            ...result.mismatched.map((row) => ({ reference: row.reference, problem: 'Nominal berbeda', ledger: money(row.ledger), gateway: money(row.gateway) })),
            ...result.missingInLedger.map((row) => ({ reference: row.reference, problem: 'Tidak ada di pembukuan', ledger: '—', gateway: money(row.amount) })),
            ...result.missingInGateway.map((payment) => ({ reference: payment.reference, problem: 'Belum diselesaikan', ledger: money(payment.amount), gateway: '—' })),
          ],
          { empty: 'Semua cocok.' },
        ),
      );
      settle.actions.append(
        act('Ekspor hasil', 'btn btn-ghost btn-sm', () =>
          downloadText(
            toCsv(['Referensi', 'Masalah', 'Pembukuan', 'Gateway'], [
              ...result.matched.map((row) => [row.reference, 'Cocok', row.amount, row.amount]),
              ...result.mismatched.map((row) => [row.reference, 'Nominal berbeda', row.ledger, row.gateway]),
              ...result.missingInLedger.map((row) => [row.reference, 'Tidak ada di pembukuan', '', row.amount]),
              ...result.missingInGateway.map((payment) => [payment.reference, 'Belum diselesaikan', payment.amount, '']),
            ]),
            `settlement-${today}.csv`,
          ),
        'download'),
      );
    }
    return [settle.root];
  }

  // ---------- summary ----------
  function summaryTab(): HTMLElement[] {
    const now = totals(orders, state.refunds);
    const was = earlier ? totals(earlier.orders, state.refunds) : null;
    const summary = section('Ringkasan', compared ? `Angka utama rentang ini, dibanding ${COMPARES.find((entry) => entry.value === view.compare)!.label.toLowerCase()} (${period}). Refund dihitung pada tanggal pesanannya.` : 'Angka utama rentang ini. Refund dihitung pada tanggal pesanannya.');
    const tile = (label: string, pick: (t: Totals) => number, format: (n: number) => string = (n) => n.toLocaleString('id-ID')) => ({ label, value: format(pick(now)), hint: was ? versus(pick(now), pick(was), period) : '' });
    summary.body.append(
      statRow([
        tile('Pendapatan bersih', (t) => t.net, money),
        tile('Transaksi', (t) => t.orders),
        tile('Rata-rata per transaksi', (t) => t.average, money),
      ]),
      statRow([
        tile('Sesi foto', (t) => t.sessions),
        tile('Cetakan tambahan', (t) => t.prints),
        { label: 'Diskon dan refund', value: money(now.discount + now.refunds), hint: `Diskon ${money(now.discount)} · refund ${money(now.refunds)}` },
      ]),
    );

    const daily = section('Per hari', compared ? `Batang untuk rentang ini; garis untuk ${period}, hari ke hari.` : 'Setiap hari dalam rentang ini.');
    daily.body.append(
      pills(METRICS, view.metric, (metric) => {
        view.metric = metric;
        redraw();
      }),
      dayTrend(view.metric),
    );
    return [summary.root, daily.root];
  }

  /** A day-by-day chart of one measure, with the compared period's matching days as marks. */
  function dayTrend(metric: Metric): HTMLElement {
    const all = daysBetween(view.from, view.to);
    const days = all.slice(-62);
    const now = dailySeries(orders, state.refunds, days, zone, metric);
    const was = compared && earlier ? dailySeries(earlier.orders, state.refunds, daysBetween(compared.from, compared.to).slice(-62), zone, metric) : null;
    const format = metric === 'net' ? compact : (value: number) => value.toLocaleString('id-ID');
    const chart = trendChart(days, now, was, format);
    const key = chartLegend(span(days[0], days.at(-1)!), was ? period : '');
    if (days.length < all.length) key.append(' · 62 hari terakhir');
    chart.prepend(key);
    return chart;
  }

  // ---------- busy hours ----------
  function hoursTab(): HTMLElement[] {
    const grid = busyHours(orders, zone);
    const values = view.heat === 'orders' ? grid.orders : grid.revenue;
    // At least 09.00 to 21.00, the venue's usual day, widened to any hour that saw a sale.
    const used = [...Array(24).keys()].filter((hour) => WEEK.some((day) => grid.orders[day][hour] > 0));
    const first = Math.min(9, ...used);
    const hours = [...Array(Math.max(21, ...used) - first + 1).keys()].map((offset) => first + offset);
    const top = Math.max(1, ...WEEK.flatMap((day) => hours.map((hour) => values[day][hour])));
    const busy = section('Jam ramai', grid.peak ? `Paling ramai: ${DAY_NAMES[grid.peak.weekday]} ${hourLabel(grid.peak.hour)}–${hourLabel(grid.peak.hour + 1)}, ${grid.peak.orders} transaksi dalam rentang ini. Pakai untuk menyusun jadwal kru dan happy hour.` : 'Belum ada transaksi lunas di rentang ini.');
    exports(busy.actions, `busy-hours-${view.heat}`, ['Hari', ...hours.map(hourLabel)], WEEK.map((day) => [DAY_NAMES[day], ...hours.map((hour) => values[day][hour])]));
    const heat = el('table', 'heat-table');
    const head = el('tr');
    head.append(el('th', '', ''), ...hours.map((hour) => el('th', '', hourLabel(hour).slice(0, 2))));
    heat.append(head);
    for (const day of WEEK) {
      const row = el('tr');
      row.append(el('th', '', DAY_NAMES[day].slice(0, 3)));
      for (const hour of hours) {
        const value = values[day][hour];
        const cell = el('td', 'heat-cell', value ? (view.heat === 'orders' ? String(value) : `${Math.round(value / 1000)}k`) : '');
        cell.style.setProperty('--heat', String(value / top));
        cell.title = `${DAY_NAMES[day]} ${hourLabel(hour)}: ${grid.orders[day][hour]} transaksi, ${money(grid.revenue[day][hour])}`;
        row.append(cell);
      }
      heat.append(row);
    }
    const scroll = el('div', 'heat-scroll');
    scroll.append(heat);
    busy.body.append(
      pills([{ value: 'orders', label: 'Transaksi' }, { value: 'revenue', label: 'Pendapatan' }] as const, view.heat, (metric) => {
        view.heat = metric;
        redraw();
      }),
      scroll,
    );
    return [busy.root];
  }

  // ---------- cashiers, refunds and cancellations ----------
  function staffTab(): HTMLElement[] {
    // Orders are cancelled at the till, so a booth or kiosk filter leaves no cancellations.
    const boothOnly = filter.channel === 'booth' || (!!filter.boothId && filter.boothId !== 'cashier');
    const voids = boothOnly ? [] : state.activity.filter((entry) => entry.kind === 'order.void' && inRange(entry.at) && seesBranch(actor, entry.branchId) && (!filter.branchId || entry.branchId === filter.branchId) && (!filter.staffId || entry.staffId === filter.staffId));
    const rows = staffReport(orders, refunds, voids);
    const earlierSales = earlier ? new Map(staffReport(earlier.orders, [], []).map((row) => [row.staffId, row.gross])) : null;
    const people = section('Per kasir', 'Penjualan lunas yang dibuat tiap orang, refund yang mereka minta, refund yang mereka setujui dengan PIN, dan pesanan yang mereka batalkan.');
    const headers = ['Nama', 'Transaksi', 'Penjualan', 'Refund diminta', 'Nilai refund', 'Refund disetujui', 'Dibatalkan'];
    exports(people.actions, 'cashiers', headers, rows.map((row) => [staffName(row.staffId), row.orders, row.gross, row.refunds, row.refunded, row.approved, row.voids]));
    people.body.append(
      compareBars(rows.map((row) => ({ label: staffName(row.staffId), now: row.gross, before: earlierSales ? (earlierSales.get(row.staffId) ?? 0) : null })), money, legend()),
      table(
        [
          { label: 'Nama', cell: (row) => staffName(row.staffId) },
          { label: 'Transaksi', className: 'num', cell: (row) => String(row.orders) },
          { label: 'Penjualan', className: 'num', cell: (row) => money(row.gross) },
          { label: 'Refund diminta', className: 'num', cell: (row) => (row.refunds ? `${row.refunds} · ${money(row.refunded)}` : '—') },
          { label: 'Refund disetujui', className: 'num', cell: (row) => (row.approved ? String(row.approved) : '—') },
          { label: 'Dibatalkan', className: 'num', cell: (row) => (row.voids ? String(row.voids) : '—') },
        ],
        rows,
        { empty: 'Belum ada transaksi di rentang ini.' },
      ),
    );

    const numbers = new Map(state.orders.map((order) => [order.id, order.number]));
    const given = section('Refund', 'Setiap refund dengan alasannya, siapa yang meminta, dan supervisor yang menyetujui.');
    const givenRows = [...refunds].sort((a, b) => b.at - a.at);
    exports(given.actions, 'refunds', ['Waktu', 'Pesanan', 'Nilai', 'Alasan', 'Diminta', 'Disetujui'], givenRows.map((entry) => [dateTime(entry.at), numbers.get(entry.orderId) ?? '', entry.amount, entry.reason, staffName(entry.staffId), staffName(entry.supervisorId)]));
    given.body.append(
      table(
        [
          { label: 'Waktu', cell: (entry) => dateTime(entry.at) },
          { label: 'Pesanan', cell: (entry) => numbers.get(entry.orderId) ?? '—' },
          { label: 'Nilai', className: 'num', cell: (entry) => money(entry.amount) },
          { label: 'Alasan', cell: (entry) => entry.reason },
          { label: 'Diminta', cell: (entry) => staffName(entry.staffId) },
          { label: 'Disetujui', cell: (entry) => staffName(entry.supervisorId) },
        ],
        givenRows,
        { empty: 'Tidak ada refund di rentang ini.' },
      ),
    );

    const cancelled = section('Pesanan dibatalkan', 'Pesanan yang dibatalkan sebelum lunas. Pesanan yang sudah dibayar hanya bisa di-refund.');
    cancelled.body.append(
      table(
        [
          { label: 'Waktu', cell: (entry) => dateTime(entry.at) },
          { label: 'Oleh', cell: (entry) => staffName(entry.staffId) },
          { label: 'Keterangan', cell: (entry) => entry.message },
        ],
        voids,
        { empty: 'Tidak ada pesanan dibatalkan di rentang ini.' },
      ),
    );
    return [people.root, given.root, cancelled.root];
  }

  // ---------- vouchers and discounts ----------
  function discountsTab(): HTMLElement[] {
    const rows = discountReport(orders, state.vouchers, state.presets);
    const given = rows.filter((row) => row.kind !== 'receipt');
    const label = (row: (typeof rows)[number]) => (row.kind === 'receipt' ? 'Kode struk (sesi yang sudah dibayar di kasir)' : row.kind === 'voucher' ? `Voucher ${row.name}` : `Preset ${row.name}`);
    const discounts = section('Voucher dan diskon', 'Pemakaian tiap voucher dan preset diskon: berapa potongan yang diberikan, dan berapa pendapatan yang tetap masuk dari pesanan itu.');
    discounts.body.append(
      statRow([
        { label: 'Potongan diberikan', value: money(given.reduce((sum, row) => sum + row.discount, 0)), hint: 'Voucher dan preset, tanpa kode struk' },
        { label: 'Pesanan berdiskon', value: String(given.reduce((sum, row) => sum + row.orders, 0)), hint: `dari ${totals(orders, []).orders} transaksi` },
        { label: 'Pendapatan dari pesanan berdiskon', value: money(given.reduce((sum, row) => sum + row.revenue, 0)) },
      ]),
    );
    exports(discounts.actions, 'discounts', ['Voucher atau preset', 'Pesanan', 'Potongan', 'Pendapatan'], rows.map((row) => [label(row), row.orders, row.discount, row.revenue]));
    discounts.body.append(
      table(
        [
          { label: 'Voucher atau preset', cell: label },
          { label: 'Pesanan', className: 'num', cell: (row) => String(row.orders) },
          { label: 'Potongan', className: 'num', cell: (row) => money(row.discount) },
          { label: 'Pendapatan', className: 'num', cell: (row) => money(row.revenue) },
        ],
        rows,
        { empty: 'Tidak ada voucher atau diskon dipakai di rentang ini.' },
      ),
    );
    return [discounts.root];
  }

  // ---------- the close of a day ----------
  /** One printed page for the owner: what came in, how, what went back, and every drawer. */
  function printDayClose(date: string): Promise<void> {
    const sameDay = (time: number) => zonedTime(time, zone).date === date;
    const day = ordersOn((on) => on === date);
    const sums = totals(day, state.refunds);
    const taken = takenByMethod(day);
    const given = state.refunds.filter((entry) => sameDay(entry.at) && day.some((order) => order.id === entry.orderId));
    const shifts = state.shifts.filter((shift) => seesBranch(actor, shift.branchId) && sameDay(shift.openedAt));
    const voids = state.activity.filter((entry) => entry.kind === 'order.void' && sameDay(entry.at) && seesBranch(actor, entry.branchId)).length;
    const css = '@page { size: A4; margin: 16mm } body { font: 12px/1.5 system-ui, sans-serif; color: #111; margin: 0 } h1 { font-size: 20px; margin: 0 0 2px } h2 { font-size: 14px; margin: 18px 0 6px } p { margin: 0 0 4px } table { width: 100%; border-collapse: collapse } td, th { text-align: left; padding: 4px 6px; border-bottom: 1px solid #ddd } .num { text-align: right; font-variant-numeric: tabular-nums } .muted { color: #666 }';
    return printDocument(css, (doc) => {
      const node = (tag: string, text = '', className = '') => {
        const element = doc.createElement(tag);
        element.textContent = text;
        if (className) element.className = className;
        return element;
      };
      const grid = (rows: [string, string][]) => {
        const body = doc.createElement('table');
        for (const [left, right] of rows) {
          const row = doc.createElement('tr');
          row.append(node('td', left), node('td', right, 'num'));
          body.append(row);
        }
        return body;
      };
      doc.body.append(
        node('h1', `Tutup hari ${ops.account.business}`),
        node('p', new Date(`${date}T00:00:00Z`).toLocaleDateString('id-ID', { dateStyle: 'full', timeZone: 'UTC' }), 'muted'),
        node('p', `Dicetak ${new Date().toLocaleString('id-ID')} oleh ${actor?.name ?? 'staf'}`, 'muted'),
        node('h2', 'Penjualan'),
        grid([
          ['Transaksi lunas', String(sums.orders)],
          ['Pendapatan kotor', money(sums.gross)],
          ['Refund', `−${money(sums.refunds)}`],
          ['Pendapatan bersih', money(sums.net)],
          ['Diskon diberikan', money(sums.discount)],
          ['Sesi foto terjual', String(sums.sessions)],
          ['Cetakan tambahan', String(sums.prints)],
          ['Pesanan dibatalkan', String(voids)],
        ]),
        node('h2', 'Uang masuk per metode'),
        grid(PAYMENT_METHODS.map((method) => [PAYMENT_LABELS[method], money(taken[method])])),
        node('h2', 'Tunai per shift'),
        shifts.length
          ? grid(
              shifts.map((shift) => {
                const slip = shiftSlip(shift, state.orders, state.refunds);
                const counted = slip.countedCash === null ? 'belum ditutup' : `dihitung ${money(slip.countedCash)}, selisih ${money(slip.variance ?? 0)}`;
                return [`${ops.branchName(shift.branchId)} · ${staffName(shift.staffId)}`, `seharusnya ${money(slip.expectedCash)} · ${counted}`];
              }),
            )
          : node('p', 'Tidak ada shift hari ini.', 'muted'),
        node('h2', 'Refund'),
        given.length ? grid(given.map((entry) => [`${new Date(entry.at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} · ${entry.reason} · disetujui ${staffName(entry.supervisorId)}`, money(entry.amount)])) : node('p', 'Tidak ada refund.', 'muted'),
      );
    });
  }
}
