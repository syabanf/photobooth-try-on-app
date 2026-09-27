import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from './filter';

const FRAME = 1 / 30;

function run(filter: OneEuroFilter, samples: number[], start = 0): number[] {
  let out: number[] = [];
  samples.forEach((sample, i) => (out = filter.filter([sample], start + i * FRAME)));
  return out;
}

describe('OneEuroFilter', () => {
  it('takes the first sample as is', () => {
    expect(new OneEuroFilter({ minCutoff: 1, beta: 0 }).filter([5, 7], 0)).toEqual([5, 7]);
  });

  it('settles on a constant input', () => {
    const filter = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    expect(run(filter, [0, ...new Array(90).fill(10)])[0]).toBeCloseTo(10, 1);
  });

  it('damps jitter around a resting value', () => {
    const filter = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    const noisy = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 2 : -2));
    let swing = 0;
    let previous = filter.filter([noisy[0]], 0)[0];
    noisy.slice(1).forEach((sample, i) => {
      const value = filter.filter([sample], (i + 1) * FRAME)[0];
      swing = Math.max(swing, Math.abs(value - previous));
      previous = value;
    });
    expect(swing).toBeLessThan(1);
  });

  it('follows a fast move sooner when beta is set', () => {
    const step = [0, ...new Array(5).fill(300)];
    const stiff = run(new OneEuroFilter({ minCutoff: 1, beta: 0 }), step)[0];
    const quick = run(new OneEuroFilter({ minCutoff: 1, beta: 0.01 }), step)[0];
    expect(quick).toBeGreaterThan(stiff);
    expect(quick).toBeGreaterThan(200);
  });

  it('starts over after a reset or a change of length', () => {
    const filter = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    run(filter, [0, 0, 0]);
    filter.reset();
    expect(filter.filter([10], 1)).toEqual([10]);
    expect(filter.filter([1, 2], 1.1)).toEqual([1, 2]);
  });
});
