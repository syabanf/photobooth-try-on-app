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
  if (voucher.eventMode) return 'Free event';
  if (voucher.kind === 'free') return 'Free session';
  return voucher.kind === 'percent' ? `${voucher.value}% off` : `${money(voucher.value)} off`;
}

export function renderVouchers({ ops, redraw }: PageContext): HTMLElement {
  const { state } = ops;
  const root = page('Vouchers', 'Codes customers type at the booth or the till. Each booth checks dates and happy hours on its own clock, so overseas booths follow local time.');
  root.actions.append(act('New voucher', 'btn btn-primary', () => editVoucher(ops), 'plus'), act('Batch of codes', 'btn btn-outline', () => batchDialog(ops), 'ticket'));
  root.body.append(
    pills([{ value: 'promo', label: 'Promotions and events' }, { value: 'receipt', label: 'Receipt codes' }] as const, view.show, (show) => {
      view.show = show;
      redraw();
    }),
  );
  const boothZone = ops.hooks.devicePointId();
  const rows = state.vouchers.filter((voucher) => (view.show === 'receipt') === !!voucher.orderId).slice(0, 400);
  root.body.append(
    table(
      [
        { label: 'Code', cell: (voucher) => el('span', 'code', voucher.code) },
        { label: 'Gives', cell: describe },
        { label: 'Booths', cell: (voucher) => (voucher.boothIds.length ? voucher.boothIds.map((id) => ops.boothName(id)).join(', ') : 'All') },
        { label: 'Valid', cell: (voucher) => [voucher.validFrom || 'now', voucher.validTo || 'open'].join(' – ') + (voucher.happyHour ? ` · ${voucher.happyHour.days.map((d) => WEEKDAY_NAMES[d]).join(' ')} ${voucher.happyHour.start}–${voucher.happyHour.end}` : '') },
        { label: 'Frames', cell: (voucher) => (voucher.frameIds.length ? voucher.frameIds.map((id) => state.frames.find((f) => f.id === id)?.name ?? '?').join(', ') : '—') },
        { label: 'Used', className: 'num', cell: (voucher) => `${voucher.uses} / ${voucher.maxUses}` },
        {
          label: 'Now',
          cell: (voucher) => {
            const problem = voucherProblem(voucher, { now: Date.now(), boothId: null, timeZone: ops.timeZoneOf(boothZone) });
            return problem ? badge(problem.replace(/\.$/, ''), 'muted') : badge('Usable', 'ok');
          },
        },
      ],
      rows,
      { empty: view.show === 'receipt' ? 'Receipt codes appear here once the till sells a session.' : 'No vouchers yet.', onRow: (voucher) => editVoucher(ops, voucher) },
    ),
  );
  return root.root;
}

function editVoucher(ops: PageContext['ops'], voucher?: Voucher): void {
  const booths = ops.visibleBooths().map((point) => ({ value: point.id, label: point.name }));
  const frames = ops.state.frames.map((frame) => ({ value: frame.id, label: frame.name }));
  formDialog({
    title: voucher ? `Edit ${voucher.code}` : 'New voucher',
    submitLabel: 'Save',
    fields: [
      { name: 'code', label: 'Code', value: voucher?.code ?? generateCode('', 6) },
      { name: 'kind', label: 'Gives', value: voucher?.kind ?? 'percent', options: [{ value: 'percent', label: 'Percent off' }, { value: 'amount', label: 'Rupiah off' }, { value: 'free', label: 'A free session' }] },
      { name: 'value', label: 'Value', value: String(voucher?.value ?? ''), type: 'number', hint: 'Percent or rupiah. Ignored for a free session.' },
      { name: 'scope', label: 'Use', value: voucher?.scope ?? 'multi', options: [{ value: 'single', label: 'One session, once' }, { value: 'multi', label: 'Many sessions, across booths' }] },
      { name: 'maxUses', label: 'Most uses', value: String(voucher?.maxUses ?? 100), type: 'number' },
      { name: 'boothIds', label: 'Booths', value: voucher?.boothIds ?? [], options: booths, hint: 'None ticked means every booth.' },
      { name: 'validFrom', label: 'Valid from', value: voucher?.validFrom ?? '', type: 'date' },
      { name: 'validTo', label: 'Valid until', value: voucher?.validTo ?? '', type: 'date' },
      { name: 'days', label: 'Happy hour days', value: (voucher?.happyHour?.days ?? []).map(String), options: WEEKDAY_NAMES.map((name, index) => ({ value: String(index), label: name })), hint: 'Leave empty for any time.' },
      { name: 'start', label: 'Happy hour from', value: voucher?.happyHour?.start ?? '14:00', type: 'time' },
      { name: 'end', label: 'Happy hour until', value: voucher?.happyHour?.end ?? '17:00', type: 'time' },
      { name: 'frameIds', label: 'Frames this code unlocks', value: voucher?.frameIds ?? [], options: frames, hint: 'These frames stay hidden from everyone without this code.' },
      { name: 'eventMode', label: 'Free event mode', value: voucher?.eventMode ?? false, hint: 'While valid, every session at its booths is free with no code, for weddings and sponsored events.' },
      { name: 'active', label: 'Active', value: voucher?.active ?? true },
    ],
    danger: voucher ? { label: 'Delete', run: (close) => { ops.deleteVoucher(voucher.id); close(); } } : undefined,
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
    title: 'Batch of codes',
    description: 'Creates single-use codes with the same offer, and downloads them as a CSV.',
    submitLabel: 'Create',
    fields: [
      { name: 'count', label: 'How many', value: '20', type: 'number' },
      { name: 'prefix', label: 'Prefix', value: 'PROMO' },
      { name: 'kind', label: 'Gives', value: 'free', options: [{ value: 'free', label: 'A free session' }, { value: 'percent', label: 'Percent off' }, { value: 'amount', label: 'Rupiah off' }] },
      { name: 'value', label: 'Value', value: '', type: 'number' },
      { name: 'validTo', label: 'Valid until', value: '', type: 'date' },
    ],
    async submit(values) {
      const count = Math.min(500, parseAmount(String(values.count)));
      if (count <= 0) throw new Error('Enter how many.');
      const codes: string[] = [];
      for (let i = 0; i < count; i++) {
        let code = generateCode(String(values.prefix), 6);
        while (ops.state.vouchers.some((v) => v.code === code) || codes.includes(code)) code = generateCode(String(values.prefix), 6);
        codes.push(code);
      }
      ops.edit('vouchers.manage', 'voucher.batch', `Created ${count} ${values.prefix} codes.`, (draft) => {
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
      downloadText(toCsv(['Code'], codes.map((code) => [code])), `${String(values.prefix).toLowerCase()}-codes.csv`);
    },
  });
}

