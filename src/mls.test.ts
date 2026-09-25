import { describe, expect, it } from 'vitest';
import { mlsSimilarity, type ControlPair } from './mls';

type Vec = { x: number; y: number };

function pairs(from: Vec[], to: Vec[]): ControlPair[] {
  return from.map((f, i) => ({ from: f, to: to[i] }));
}

const corners: Vec[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

describe('mlsSimilarity', () => {
  it('leaves points alone when nothing moves', () => {
    const map = mlsSimilarity(pairs(corners, corners));
    const p = map({ x: 0.3, y: 0.7 });
    expect(p.x).toBeCloseTo(0.3);
    expect(p.y).toBeCloseTo(0.7);
  });

  it('translates when every control translates', () => {
    const moved = corners.map((c) => ({ x: c.x + 5, y: c.y - 2 }));
    const map = mlsSimilarity(pairs(corners, moved));
    const p = map({ x: 0.5, y: 0.25 });
    expect(p.x).toBeCloseTo(5.5);
    expect(p.y).toBeCloseTo(-1.75);
  });

  it('scales uniformly', () => {
    const scaled = corners.map((c) => ({ x: c.x * 3, y: c.y * 3 }));
    const map = mlsSimilarity(pairs(corners, scaled));
    const p = map({ x: 0.5, y: 0.5 });
    expect(p.x).toBeCloseTo(1.5);
    expect(p.y).toBeCloseTo(1.5);
  });

  it('rotates a quarter turn', () => {
    const rotated = corners.map((c) => ({ x: -c.y, y: c.x }));
    const map = mlsSimilarity(pairs(corners, rotated));
    const p = map({ x: 1, y: 0 });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(1);
  });

  it('pins a point that sits on a control', () => {
    const map = mlsSimilarity(pairs(corners, [{ x: 9, y: 9 }, ...corners.slice(1)]));
    expect(map({ x: 0, y: 0 })).toEqual({ x: 9, y: 9 });
  });

  it('bends between controls when one moves alone', () => {
    const map = mlsSimilarity(pairs(corners, [corners[0], corners[1], { x: 2, y: 1 }, corners[3]]));
    const near = map({ x: 0.9, y: 0.9 });
    const far = map({ x: 0.1, y: 0.1 });
    expect(near.x).toBeGreaterThan(0.95);
    expect(far.x).toBeCloseTo(0.1, 1);
  });

  it('falls back to a translation for a single control', () => {
    const map = mlsSimilarity([{ from: { x: 0, y: 0 }, to: { x: 4, y: 4 } }]);
    expect(map({ x: 1, y: 2 })).toEqual({ x: 5, y: 6 });
  });
});
