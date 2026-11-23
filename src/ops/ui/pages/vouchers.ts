// Vouchers: one-session codes, multi-booth codes, happy hours, frames a code unlocks, and free
// event mode, all checked on each booth's own clock.

import { formDialog } from '../../../dialogs';
import type { Voucher } from '../../model';
import { WEEKDAY_NAMES } from '../../time';
import { generateCode, voucherProblem } from '../../vouchers';
import type { PageContext } from '../router';
import { act, badge, downloadText, el, money, page, parseAmount, pills, table } from '../kit';
import { toCsv } from '../../reports';

const view = { show: 'promo' as 'promo' | 'receipt' };

function describe(voucher: Voucher): string {
  if (voucher.eventMode) return 'Acara gratis';
  if (voucher.kind === 'free') return 'Sesi gratis';
  return voucher.kind === 'percent' ? `Diskon ${voucher.value}%` : `Diskon ${money(voucher.value)}`;
}

export function renderVouchers({ ops, redraw }: PageContext): HTMLElement {
  const { state } = ops;
  const root = page('Voucher', 'Kode yang diketik pelanggan di booth atau kasir. Setiap booth memeriksa tanggal dan happy hour dengan jamnya sendiri, jadi booth di luar negeri mengikuti waktu setempat.');
  root.actions.append(act('Voucher baru', 'btn btn-primary', () => editVoucher(ops), 'plus'), act('Kode massal', 'btn btn-outline', () => batchDialog(ops), 'ticket'));
  root.body.append(
    pills([{ value: 'promo', label: 'Promo dan acara' }, { value: 'receipt', label: 'Kode dari struk' }] as const, view.show, (show) => {
      view.show = show;
      redraw();
    }),
  );
  const boothZone = ops.hooks.devicePointId();
  const rows = state.vouchers.filter((voucher) => (view.show === 'receipt') === !!voucher.orderId).slice(0, 400);
  root.body.append(
    table(
      [
        { label: 'Kode', cell: (voucher) => el('span', 'code', voucher.code) },
        { label: 'Memberi', cell: describe },
        { label: 'Booth', cell: (voucher) => (voucher.boothIds.length ? voucher.boothIds.map((id) => ops.boothName(id)).join(', ') : 'Semua') },
        { label: 'Berlaku', cell: (voucher) => [voucher.validFrom || 'sekarang', voucher.validTo || 'tanpa batas'].join(' – ') + (voucher.happyHour ? ` · ${voucher.happyHour.days.map((d) => WEEKDAY_NAMES[d]).join(' ')} ${voucher.happyHour.start}–${voucher.happyHour.end}` : '') },
        { label: 'Bingkai', cell: (voucher) => (voucher.frameIds.length ? voucher.frameIds.map((id) => state.frames.find((f) => f.id === id)?.name ?? '?').join(', ') : '—') },
        { label: 'Dipakai', className: 'num', cell: (voucher) => `${voucher.uses} / ${voucher.maxUses}` },
        {
          label: 'Sekarang',
          cell: (voucher) => {
            const problem = voucherProblem(voucher, { now: Date.now(), boothId: null, timeZone: ops.timeZoneOf(boothZone) });
            return problem ? badge(problem.replace(/\.$/, ''), 'muted') : badge('Bisa dipakai', 'ok');
          },
        },
      ],
      rows,
      { empty: view.show === 'receipt' ? 'Kode dari struk muncul di sini setelah kasir menjual sesi.' : 'Belum ada voucher.', onRow: (voucher) => editVoucher(ops, voucher) },
    ),
  );
  return root.root;
}

function editVoucher(ops: PageContext['ops'], voucher?: Voucher): void {
  const booths = ops.visibleBooths().map((point) => ({ value: point.id, label: point.name }));
  const frames = ops.state.frames.map((frame) => ({ value: frame.id, label: frame.name }));
  formDialog({
    title: voucher ? `Ubah ${voucher.code}` : 'Voucher baru',
    submitLabel: 'Simpan',
    fields: [
      { name: 'code', label: 'Kode', value: voucher?.code ?? generateCode('', 6) },
      { name: 'kind', label: 'Memberi', value: voucher?.kind ?? 'percent', options: [{ value: 'percent', label: 'Diskon persen' }, { value: 'amount', label: 'Diskon rupiah' }, { value: 'free', label: 'Satu sesi gratis' }] },
      { name: 'value', label: 'Nilai', value: String(voucher?.value ?? ''), type: 'number', hint: 'Persen atau rupiah. Diabaikan untuk sesi gratis.' },
      { name: 'scope', label: 'Pemakaian', value: voucher?.scope ?? 'multi', options: [{ value: 'single', label: 'Satu sesi, sekali pakai' }, { value: 'multi', label: 'Banyak sesi, di semua booth' }] },
      { name: 'maxUses', label: 'Batas pemakaian', value: String(voucher?.maxUses ?? 100), type: 'number' },
      { name: 'boothIds', label: 'Booth', value: voucher?.boothIds ?? [], options: booths, hint: 'Bila tidak ada yang dicentang, berlaku di semua booth.' },
      { name: 'validFrom', label: 'Berlaku dari', value: voucher?.validFrom ?? '', type: 'date' },
      { name: 'validTo', label: 'Berlaku sampai', value: voucher?.validTo ?? '', type: 'date' },
      { name: 'days', label: 'Hari happy hour', value: (voucher?.happyHour?.days ?? []).map(String), options: WEEKDAY_NAMES.map((name, index) => ({ value: String(index), label: name })), hint: 'Kosongkan untuk kapan saja.' },
      { name: 'start', label: 'Happy hour mulai', value: voucher?.happyHour?.start ?? '14:00', type: 'time' },
      { name: 'end', label: 'Happy hour sampai', value: voucher?.happyHour?.end ?? '17:00', type: 'time' },
      { name: 'frameIds', label: 'Bingkai yang dibuka kode ini', value: voucher?.frameIds ?? [], options: frames, hint: 'Bingkai ini tersembunyi bagi siapa pun yang tidak punya kode ini.' },
      { name: 'eventMode', label: 'Mode acara gratis', value: voucher?.eventMode ?? false, hint: 'Selama berlaku, setiap sesi di booth-nya gratis tanpa kode, untuk pernikahan dan acara bersponsor.' },
      { name: 'active', label: 'Aktif', value: voucher?.active ?? true },
    ],
    danger: voucher ? { label: 'Hapus', run: (close) => { ops.deleteVoucher(voucher.id); close(); } } : undefined,
    async submit(values) {
      const days = (values.days as string[]).map(Number);
      const scope = values.scope as Voucher['scope'];
      ops.saveVoucher({
        id: voucher?.id,
        code: String(values.code),
        kind: values.kind as Voucher['kind'],
        value: parseAmount(String(values.value)),
        scope,
        maxUses: scope === 'single' ? 1 : Math.max(1, parseAmount(String(values.maxUses))),
        boothIds: values.boothIds as string[],
        validFrom: String(values.validFrom),
        validTo: String(values.validTo),
        happyHour: days.length ? { days, start: String(values.start), end: String(values.end) } : null,
        frameIds: values.frameIds as string[],
        eventMode: values.eventMode as boolean,
        active: values.active as boolean,
        orderId: voucher?.orderId,
      });
    },
  });
}

/** Prints a run of single-use codes, for flyers and partner giveaways. */
function batchDialog(ops: PageContext['ops']): void {
  formDialog({
    title: 'Kode massal',
    description: 'Membuat kode sekali pakai dengan penawaran yang sama, lalu mengunduhnya sebagai CSV.',
    submitLabel: 'Buat',
    fields: [
      { name: 'count', label: 'Jumlah', value: '20', type: 'number' },
      { name: 'prefix', label: 'Awalan', value: 'PROMO' },
      { name: 'kind', label: 'Memberi', value: 'free', options: [{ value: 'free', label: 'Satu sesi gratis' }, { value: 'percent', label: 'Diskon persen' }, { value: 'amount', label: 'Diskon rupiah' }] },
      { name: 'value', label: 'Nilai', value: '', type: 'number' },
      { name: 'validTo', label: 'Berlaku sampai', value: '', type: 'date' },
    ],
    async submit(values) {
      const count = Math.min(500, parseAmount(String(values.count)));
      if (count <= 0) throw new Error('Isi jumlahnya.');
      const codes: string[] = [];
      for (let i = 0; i < count; i++) {
        let code = generateCode(String(values.prefix), 6);
        while (ops.state.vouchers.some((v) => v.code === code) || codes.includes(code)) code = generateCode(String(values.prefix), 6);
        codes.push(code);
      }
      ops.edit('vouchers.manage', 'voucher.batch', `${count} kode ${values.prefix} dibuat.`, (draft) => {
        for (const code of codes) {
          draft.vouchers.unshift({
            id: ops.store.id(),
            code,
            kind: values.kind as Voucher['kind'],
            value: parseAmount(String(values.value)),
            scope: 'single',
            boothIds: [],
            maxUses: 1,
            uses: 0,
            validFrom: '',
            validTo: String(values.validTo),
            happyHour: null,
            frameIds: [],
            eventMode: false,
            active: true,
            createdAt: Date.now(),
          });
        }
      });
      downloadText(toCsv(['Kode'], codes.map((code) => [code])), `${String(values.prefix).toLowerCase()}-codes.csv`);
    },
  });
}

