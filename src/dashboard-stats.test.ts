import { describe, expect, it } from 'vitest';
import type { Sites } from './account/model';
import { dayStarts, percentChange, summarize, type CaptureRecord } from './dashboard-stats';

const now = new Date(2026, 8, 25, 15, 0).getTime();
const daysAgo = (n: number, hour = 12) => new Date(2026, 8, 25 - n, hour).getTime();

const sites: Sites = {
  locations: [
    { id: 'gi', name: 'Grand Indonesia', city: 'Jakarta', address: '', createdAt: 0 },
    { id: 'pk', name: 'Pakuwon Mall', city: 'Surabaya', address: '', createdAt: 0 },
  ],
  points: [
    { id: 'k1', locationId: 'gi', name: 'Kiosk 1', code: 'GRA-01', active: true, createdAt: 0 },
    { id: 'm1', locationId: 'gi', name: 'Mirror', code: 'GRA-02', active: false, createdAt: 0 },
    { id: 'b1', locationId: 'pk', name: 'Booth', code: 'PAK-01', active: true, createdAt: 0 },
  ],
};

const captures: CaptureRecord[] = [
  { kind: 'snapshot', createdAt: daysAgo(0, 9), pointId: 'k1' },
  { kind: 'photobooth', createdAt: daysAgo(0, 14), pointId: 'k1' },
  { kind: 'snapshot', createdAt: daysAgo(3), pointId: 'm1' },
  { kind: 'snapshot', createdAt: daysAgo(6, 0), pointId: null },
  // Before the 7-day window: counts as the previous period only.
  { kind: 'snapshot', createdAt: daysAgo(7), pointId: 'b1' },
  { kind: 'photobooth', createdAt: daysAgo(10), pointId: 'b1' },
  { kind: 'snapshot', createdAt: daysAgo(20), pointId: 'b1' },
];

describe('dayStarts', () => {
  it('ends on today and steps back one local day at a time', () => {
    const starts = dayStarts(7, now);
    expect(starts).toHaveLength(7);
    expect(new Date(starts[6]).getDate()).toBe(25);
    expect(new Date(starts[0]).getDate()).toBe(19);
    expect(new Date(starts[0]).getHours()).toBe(0);
  });
});

describe('summarize', () => {
  const summary = summarize(captures, sites, 7, now);

  it('counts the period, its kinds, and the period before', () => {
    expect(summary.total).toBe(4);
    expect(summary.snapshots).toBe(3);
    expect(summary.sheets).toBe(1);
    expect(summary.previous).toBe(2);
  });

  it('puts every capture on its local day, including one at midnight', () => {
    expect(summary.days.map((day) => day.count)).toEqual([1, 0, 0, 1, 0, 0, 2]);
  });

  it('ranks points and locations, busiest first', () => {
    expect(summary.points.map((entry) => [entry.item.id, entry.count])).toEqual([
      ['k1', 2],
      ['m1', 1],
      ['b1', 0],
    ]);
    expect(summary.locations.map((entry) => [entry.item.id, entry.count])).toEqual([
      ['gi', 3],
      ['pk', 0],
    ]);
  });

  it('flags active points that captured nothing, and never a paused one', () => {
    expect(summary.idlePoints.map((point) => point.id)).toEqual(['b1']);
  });
});

describe('percentChange', () => {
  it('rounds to whole percent and skips an empty previous period', () => {
    expect(percentChange(4, 2)).toBe(100);
    expect(percentChange(1, 3)).toBe(-67);
    expect(percentChange(5, 0)).toBeNull();
  });
});
