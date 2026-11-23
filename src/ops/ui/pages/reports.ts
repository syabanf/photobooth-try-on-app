// Reports in six tabs over one date range: sales (by day, branch, booth, shift, frame or mode),
// products (sessions, AI presets, prints, merchandise and best sellers), payments by method with
// fees, cash per shift, the floor (queue, gate and AI prints), and the settlement check of a
// gateway export against the ledger. Every table exports to CSV, and sales and payments to XLSX.

import { seesBranch } from '../../access';
import { xlsx } from '../../encoders';
import { PAYMENT_LABELS, PAYMENT_METHODS, SESSION_MODES, type LineKind, type PaymentMethod, type SessionMode } from '../../model';
import { paymentReport, type PaymentGroup } from '../../payments';
import { shiftSlip } from '../../shift';
import { bestSellers, floorReport, parseGatewayCsv, PRODUCT_LABELS, reconcileSettlement, revenueReport, toCsv, type GroupBy, type ReportRow, type Settlement } from '../../reports';
import { localTimeZone, zonedTime } from '../../time';
import type { PageContext } from '../router';
import { act, badge, downloadBytes, downloadText, el, fileInput, money, notice, page, pills, section, statRow, table } from '../kit';

type Tab = 'sales' | 'products' | 'payments' | 'cash' | 'floor' | 'settlement';
type Range = 'today' | '7' | '30' | 'month' | 'custom';

const view = { tab: 'sales' as Tab, range: '30' as Range, groupBy: 'day' as GroupBy, payGroup: 'method' as PaymentGroup, from: '', to: '', settlement: null as Settlement | null, fileName: '' };

const TABS: { value: Tab; label: string }[] = [
  { value: 'sales', label: 'Penjualan' },
  { value: 'products', label: 'Produk' },
  { value: 'payments', label: 'Pembayaran' },
  { value: 'cash', label: 'Tunai' },
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
  const orders = state.orders.filter((order) => seesBranch(actor, order.branchId) && inRange(order.paidAt ?? order.createdAt));
  const sessions = state.sessions.filter((session) => seesBranch(actor, session.branchId) && inRange(session.startedAt));
  const refunds = state.refunds.filter((refund) => inRange(refund.at) && orders.some((order) => order.id === refund.orderId));
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
  const revenue = (groupBy: GroupBy) => revenueReport({ orders, refunds: state.refunds, sessions, timeZone: zone, label }, groupBy);
  const sum = (rows: ReportRow[]) => rows.reduce((total, row) => ({ gross: total.gross + row.gross, refunds: total.refunds + row.refunds, net: total.net + row.net }), { gross: 0, refunds: 0, net: 0 });
  const exports = (actions: HTMLElement, name: string, headers: string[], rows: (string | number)[][], sheet?: string) => {
    actions.append(act('CSV', 'btn btn-outline btn-sm', () => downloadText(toCsv(headers, rows), `${name}-${view.from}-to-${view.to}.csv`), 'download'));
    if (sheet) actions.append(act('XLSX', 'btn btn-outline btn-sm', () => downloadBytes(xlsx(sheet, headers, rows), `${name}-${view.from}-to-${view.to}.xlsx`, XLSX_TYPE), 'download'));
  };

  const root = page('Laporan', 'Pilih tanggal sekali; semua tab memakai rentang yang sama. Hasil ekspor bisa dibuka di Excel atau Google Sheets.');

  // ---------- the range and the tabs ----------
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
  root.body.append(
    pills(TABS, view.tab, (tab) => {
      view.tab = tab;
      redraw();
    }),
    controls,
  );

  const tabs: Record<Tab, () => HTMLElement[]> = { sales: salesTab, products: productsTab, payments: paymentsTab, cash: cashTab, floor: floorTab, settlement: settlementTab };
  root.body.append(...tabs[view.tab]());
  return root.root;

  // ---------- sales ----------
  function salesTab(): HTMLElement[] {
    const rows = revenue(view.groupBy);
    const totals = sum(rows);
    const headers = ['Kelompok', 'Pesanan', 'Sesi terjual', 'Kotor', 'Refund', 'Bersih'];
    const sales = section('Penjualan', 'Pendapatan dikelompokkan sesuai kebutuhan. Bingkai dan mode menghitung sesi booth sesuai harganya.');
    exports(sales.actions, `sales-${view.groupBy}`, headers, rows.map((row) => [row.label, row.orders, row.sessions, row.gross, row.refunds, row.net]), 'Penjualan');
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
    pays.body.append(
      pills(PAY_GROUPS, view.payGroup, (group) => {
        view.payGroup = group;
        redraw();
      }),
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
}
