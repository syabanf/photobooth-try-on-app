import { describe, expect, it, vi } from 'vitest';
import { CELL_ASPECT, boothSheet, runBoothSession, shotsFor, type BoothHooks } from './photobooth';

describe('boothSheet', () => {
  it('stacks four cells for a strip, four in a 2x2 grid, one for a single', () => {
    expect(boothSheet('strip').cells).toHaveLength(shotsFor('strip'));
    expect(shotsFor('strip')).toBe(4);
    expect(shotsFor('grid')).toBe(4);
    expect(shotsFor('single')).toBe(1);
  });

  it('keeps every cell at the 4:3 photo aspect', () => {
    for (const layout of ['strip', 'grid', 'single'] as const) {
      for (const cell of boothSheet(layout).cells) {
        expect(cell.h / cell.w).toBeCloseTo(CELL_ASPECT, 2);
      }
    }
  });

  it('fits every cell and the caption inside the sheet without overlap', () => {
    for (const layout of ['strip', 'grid', 'single'] as const) {
      const sheet = boothSheet(layout);
      for (const cell of sheet.cells) {
        expect(cell.x + cell.w).toBeLessThanOrEqual(sheet.width);
        expect(cell.y + cell.h).toBeLessThanOrEqual(sheet.caption.y);
      }
      expect(sheet.caption.y + sheet.caption.h).toBeLessThanOrEqual(sheet.height);
    }
  });

  it('lays the grid out two across', () => {
    const [a, b, c] = boothSheet('grid').cells;
    expect(b.y).toBe(a.y);
    expect(b.x).toBeGreaterThan(a.x);
    expect(c.x).toBe(a.x);
    expect(c.y).toBeGreaterThan(a.y);
  });
});

describe('runBoothSession', () => {
  function hooks(cancelAfter = Infinity): BoothHooks & { counts: (number | null)[] } {
    let captures = 0;
    const counts: (number | null)[] = [];
    return {
      counts,
      capture: () => {
        captures += 1;
        return { width: 4, height: 3 } as HTMLCanvasElement;
      },
      countdown: (s) => counts.push(s),
      flash: () => undefined,
      shot: () => undefined,
      cancelled: () => captures >= cancelAfter,
    };
  }

  it('counts down before every shot and returns them all', async () => {
    vi.useFakeTimers();
    const h = hooks();
    const run = runBoothSession(2, 3, h);
    await vi.runAllTimersAsync();
    const shots = await run;
    expect(shots).toHaveLength(2);
    expect(h.counts).toEqual([3, 2, 1, null, 3, 2, 1, null]);
    vi.useRealTimers();
  });

  it('stops and returns null once cancelled', async () => {
    vi.useFakeTimers();
    const run = runBoothSession(4, 1, hooks(1));
    await vi.runAllTimersAsync();
    expect(await run).toBeNull();
    vi.useRealTimers();
  });
});
