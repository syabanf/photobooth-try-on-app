import { describe, expect, it } from 'vitest';
import { PinchDetector, REACH, pinchPoint, pinchRatio, smoothPoint, toScreen, type HandPoint } from './hand-cursor';

function hand(points: Record<number, HandPoint>): HandPoint[] {
  const out: HandPoint[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  for (const [i, p] of Object.entries(points)) out[Number(i)] = p;
  return out;
}

describe('toScreen', () => {
  it('mirrors x, so a hand on the camera left drives the cursor right', () => {
    expect(toScreen({ x: REACH.left, y: 0.4 }, 1000, 800).x).toBeCloseTo(1000);
    expect(toScreen({ x: 1 - REACH.left, y: 0.4 }, 1000, 800).x).toBeCloseTo(0);
  });

  it('maps the reach box onto the whole screen and clamps outside it', () => {
    expect(toScreen({ x: 0.5, y: REACH.top }, 1000, 800).y).toBe(0);
    expect(toScreen({ x: 0.5, y: REACH.bottom }, 1000, 800).y).toBe(800);
    expect(toScreen({ x: 0.5, y: 0.99 }, 1000, 800).y).toBe(800);
    expect(toScreen({ x: 0.5, y: 0.4 }, 1000, 800).x).toBeCloseTo(500);
  });
});

describe('pinchPoint', () => {
  it('sits halfway between thumb tip and index tip', () => {
    const p = pinchPoint(hand({ 4: { x: 0.2, y: 0.4 }, 8: { x: 0.4, y: 0.6 } }));
    expect(p.x).toBeCloseTo(0.3);
    expect(p.y).toBeCloseTo(0.5);
  });
});

describe('pinchRatio', () => {
  const open = hand({ 0: { x: 0.5, y: 0.8 }, 9: { x: 0.5, y: 0.6 }, 4: { x: 0.4, y: 0.5 }, 8: { x: 0.5, y: 0.4 } });
  const closed = hand({ 0: { x: 0.5, y: 0.8 }, 9: { x: 0.5, y: 0.6 }, 4: { x: 0.49, y: 0.45 }, 8: { x: 0.5, y: 0.44 } });

  it('is large for an open hand and small for a pinch', () => {
    expect(pinchRatio(open, 1)).toBeGreaterThan(0.5);
    expect(pinchRatio(closed, 1)).toBeLessThan(0.15);
  });

  it('does not change with distance from the camera', () => {
    const far = open.map((p) => ({ x: 0.5 + (p.x - 0.5) / 2, y: 0.5 + (p.y - 0.5) / 2 }));
    expect(pinchRatio(far, 1)).toBeCloseTo(pinchRatio(open, 1));
  });
});

describe('PinchDetector', () => {
  it('closes below the close line and opens only above the open line', () => {
    const pinch = new PinchDetector(0.3, 0.45);
    expect(pinch.update(0.6)).toBe(false);
    expect(pinch.update(0.25)).toBe(true);
    expect(pinch.update(0.4)).toBe(true);
    expect(pinch.update(0.5)).toBe(false);
    expect(pinch.update(0.35)).toBe(false);
  });
});

describe('smoothPoint', () => {
  it('starts at the first reading and eases toward later ones', () => {
    expect(smoothPoint(null, { x: 10, y: 10 }, 0.4)).toEqual({ x: 10, y: 10 });
    expect(smoothPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
  });
});
