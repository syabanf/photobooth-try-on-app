import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from './model';
import { areaOf, byDay, countByArea, filterHistory, type HistoryFilter } from './history';

const at = (day: number, hour: number) => Date.UTC(2026, 10, day, hour);
const entry = (id: string, kind: string, time: number, staffId: string | null = 'rizky', branchId: string | null = 'lembang', message = kind): ActivityEntry => ({ id, kind, at: time, staffId, branchId, message });

const log = [
  entry('a', 'order.pay', at(8, 3), 'sari', 'lembang', 'INV-0001 paid in cash'),
  entry('b', 'auth.signin', at(8, 2), 'rizky', null, 'Rizky signed in.'),
  entry('c', 'alert.low-paper', at(9, 1), null, 'lembang', 'Booth 1 is low on paper'),
  entry('d', 'preset.price', at(9, 4), 'rizky', null, 'A printed AI preset costs Rp25.000.'),
  entry('e', 'face.tag', at(10, 5), 'sari', 'bandung', 'Named a face Dina.'),
];

const all: HistoryFilter = { from: '', to: '', staffId: '', area: '', branchId: '', query: '', timeZone: 'Asia/Jakarta' };

describe('activity history', () => {
  it('sorts kinds into areas', () => {
    expect(areaOf('order.refund')).toBe('sales');
    expect(areaOf('auth.invite')).toBe('access');
    expect(areaOf('alert.camera-disconnected')).toBe('devices');
    expect(areaOf('preset.price')).toBe('settings');
    expect(areaOf('preset.save')).toBe('content');
    expect(areaOf('mystery')).toBe('other');
  });

  it('filters by local date, person, the system, area, branch and words', () => {
    const ids = (filter: Partial<HistoryFilter>) => filterHistory(log, { ...all, ...filter }).map((e) => e.id);
    // 1:00 UTC on the 9th is 8:00 in Jakarta on the 9th; 3:00 UTC on the 8th is the 8th.
    expect(ids({ from: '2026-11-09', to: '2026-11-09' })).toEqual(['c', 'd']);
    expect(ids({ staffId: 'sari' })).toEqual(['a', 'e']);
    expect(ids({ staffId: 'system' })).toEqual(['c']);
    expect(ids({ area: 'access' })).toEqual(['b']);
    expect(ids({ branchId: 'bandung' })).toEqual(['e']);
    expect(ids({ query: 'PAID cash' })).toEqual(['a']);
  });

  it('groups by local day, newest first, and counts areas', () => {
    const late = entry('f', 'order.pay', Date.UTC(2026, 10, 8, 18), 'sari'); // 01:00 on the 9th in Jakarta
    expect(byDay([...log, late], 'Asia/Jakarta').map((day) => [day.date, day.entries.map((e) => e.id)])).toEqual([
      ['2026-11-10', ['e']],
      ['2026-11-09', ['d', 'c', 'f']],
      ['2026-11-08', ['a', 'b']],
    ]);
    expect(countByArea(log)).toEqual({ sales: 1, access: 1, devices: 1, settings: 1, faces: 1 });
  });
});
