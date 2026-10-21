import { describe, expect, it } from 'vitest';
import type { Frame, Voucher } from './model';
import { activeEvent, availableFrames, checkVoucher, generateCode, voucherDiscount, voucherProblem } from './vouchers';

const base: Voucher = {
  id: 'v1',
  code: 'HAPPY50',
  kind: 'percent',
  value: 50,
  scope: 'multi',
  boothIds: [],
  maxUses: 100,
  uses: 0,
  validFrom: '2026-10-01',
  validTo: '2026-10-31',
  happyHour: null,
  frameIds: [],
  eventMode: false,
  active: true,
  createdAt: 0,
};

// 19 Oct 2026 08:30 UTC is a Monday: 15:30 in Jakarta, 17:30 in Sydney (AEDT).
const monday = Date.UTC(2026, 9, 19, 8, 30);
const jakarta = { now: monday, boothId: 'b1', timeZone: 'Asia/Jakarta' };

describe('voucherProblem', () => {
  it('accepts a valid code, ignoring case and spaces', () => {
    expect(checkVoucher([base], ' happy 50 ', jakarta)).toEqual({ ok: true, voucher: base });
  });

  it('names the reason a code fails', () => {
    expect(checkVoucher([base], 'NOPE', jakarta)).toEqual({ ok: false, reason: 'No voucher matches NOPE.' });
    expect(voucherProblem({ ...base, active: false }, jakarta)).toBe('This voucher is switched off.');
    expect(voucherProblem({ ...base, boothIds: ['b2'] }, jakarta)).toBe('This voucher is not valid at this booth.');
    expect(voucherProblem({ ...base, validTo: '2026-10-18' }, jakarta)).toBe('Expired on 2026-10-18.');
    expect(voucherProblem({ ...base, validFrom: '2026-10-20' }, jakarta)).toBe('Valid from 2026-10-20.');
    expect(voucherProblem({ ...base, scope: 'single', maxUses: 1, uses: 1 }, jakarta)).toBe('This voucher was already used.');
  });

  it('lets the cashier check a booth-locked code', () => {
    expect(voucherProblem({ ...base, boothIds: ['b2'] }, { ...jakarta, boothId: null })).toBeNull();
  });

  it('applies happy hour on the booth clock, not the server clock', () => {
    const happy = { ...base, happyHour: { days: [1, 2, 3, 4, 5], start: '14:00', end: '17:00' } };
    expect(voucherProblem(happy, jakarta)).toBeNull();
    // Same instant in Sydney is 17:30, after the window closes.
    expect(voucherProblem(happy, { ...jakarta, timeZone: 'Australia/Sydney' })).toBe('Valid Mon, Tue, Wed, Thu, Fri 14:00–17:00 only.');
  });

  it('rolls the date over at the booth’s midnight', () => {
    // 23:30 UTC on 31 Oct is already 1 Nov in Jakarta.
    const late = Date.UTC(2026, 9, 31, 23, 30);
    expect(voucherProblem(base, { ...jakarta, now: late })).toBe('Expired on 2026-10-31.');
    expect(voucherProblem(base, { ...jakarta, now: late, timeZone: 'UTC' })).toBeNull();
  });
});

describe('discounts and events', () => {
  it('caps every discount at the amount', () => {
    expect(voucherDiscount(base, 35_000)).toBe(17_500);
    expect(voucherDiscount({ ...base, kind: 'amount', value: 50_000 }, 35_000)).toBe(35_000);
    expect(voucherDiscount({ ...base, kind: 'free' }, 35_000)).toBe(35_000);
  });

  it('finds the free event running at a booth', () => {
    const event = { ...base, id: 'e', code: 'WEDDING', eventMode: true, kind: 'free' as const, boothIds: ['b1'] };
    expect(activeEvent([base, event], jakarta)?.id).toBe('e');
    expect(activeEvent([base, event], { ...jakarta, boothId: 'b9' })).toBeNull();
  });
});

describe('availableFrames', () => {
  const frame = (id: string): Frame => ({ id, name: id, category: '', size: '4R', image: '', width: 1, height: 1, slots: [], active: true });
  const frames = [frame('open'), frame('gold')];
  const gold = { ...base, frameIds: ['gold'] };

  it('hides a voucher-locked frame until its voucher is applied', () => {
    expect(availableFrames(frames, [gold], null).map((f) => f.id)).toEqual(['open']);
    expect(availableFrames(frames, [gold], gold).map((f) => f.id)).toEqual(['open', 'gold']);
  });
});

describe('generateCode', () => {
  it('uses only unambiguous characters', () => {
    const code = generateCode('s-', 8, () => 0.999);
    expect(code).toBe('S-99999999');
    expect(generateCode('', 6)).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
  });
});
